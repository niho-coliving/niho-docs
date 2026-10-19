import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { ensurePrivateAcl } from './acl.mjs';
import { audioFormat } from './audio-format.mjs';
import { TranscriptionError } from './errors.mjs';
import { markdownCollector } from './markdown.mjs';
import { validateAudioSnapshot, verifyAudioSnapshot } from './snapshot.mjs';
export { TranscriptionError } from './errors.mjs';

const childLauncher = fileURLToPath(new URL('./private-child.mjs', import.meta.url));
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
export const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 2 * GiB, // C1 audio upload ceiling. The transport and claim contract use the same inclusive bound.
  maxDurationSec: 6 * 3600,
  maxWorkspaceBytes: 2 * GiB + 6 * 3600 * 32000 + 44 + 32 * MiB, // speaker map 16 MiB + existing 16 MiB workspace margin
  minFreeBytes: 512 * MiB,
  maxOutputBytes: 16 * MiB,
  maxSpeakerMapBytes: 16 * MiB,
  maxLineBytes: MiB,
  maxSegments: 100000,
  maxCandidateBytes: 8 * MiB,
  maxChunks: 1000,
  timeoutMs: 6 * 3600 * 1000,
  killGraceMs: 1000,
  monitorMs: 100,
});

const fail = (code) => { throw new TranscriptionError(code); };
const number = (n) => typeof n === 'number' && Number.isFinite(n);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, code = 'sidecar_protocol') => { if (!ok) fail(code); };

function limitsFor(overrides) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    check(Object.hasOwn(limits, key) && number(value) && value >= 0, 'invalid_configuration');
    check(key === 'maxDurationSec' || Number.isSafeInteger(value), 'invalid_configuration');
    // A transport adapter can lower resource ceilings, never raise C0 ceilings.
    check(key === 'minFreeBytes' ? value >= limits[key] : value > 0 && value <= limits[key], 'invalid_configuration');
    limits[key] = value;
  }
  return limits;
}

function sanitizedEnvironment(workspace) {
  // HOME is required for Apple's installed speech assets. No API credentials,
  // shell startup, proxy, NODE_OPTIONS, or DYLD injection variables are inherited.
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    TMPDIR: workspace,
  };
}

export async function workspaceBytes(path, inspectPath = lstat) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    let info;
    try { info = await inspectPath(childPath); }
    catch (error) {
      // AVFoundation atomically renames its temporary WAV into place. A file
      // that vanished after readdir is not a workspace violation.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    check(info.uid === process.getuid() && !info.isSymbolicLink(), 'workspace_invalid');
    if (info.isDirectory()) {
      check((info.mode & 0o077) === 0, 'workspace_invalid');
      total += await workspaceBytes(childPath, inspectPath);
    } else {
      check(info.isFile() && (info.mode & 0o077) === 0, 'workspace_invalid');
      total += info.size;
    }
  }
  return total;
}

/** 置き場の空き byte 数（service.mjs が download 前にも同じ見積りで確かめる）。 */
export async function diskAvailable(path) {
  const fs = await statfs(path, { bigint: true });
  return fs.bavail * fs.bsize;
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    // Darwin can return EPERM for a group containing only exiting zombies.
    if (error.code !== 'ESRCH' && !(process.platform === 'darwin' && error.code === 'EPERM')) throw new TranscriptionError('process_cleanup_failed');
  }
}

/** Stream and validate all stdout; stderr is drained and discarded, never logged. */
async function command(binary, args, context, onValue) {
  context.assertActive();
  const child = spawn(process.execPath, [childLauncher, binary, ...args], {
    shell: false,
    detached: true,
    cwd: context.workspace,
    env: sanitizedEnvironment(context.workspace),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let failure;
  let killTimer;
  const stop = () => {
    if (killTimer) return;
    try { signalGroup(child.pid, 'SIGTERM'); } catch (error) { failure ??= error; }
    killTimer = setTimeout(() => {
      try { signalGroup(child.pid, 'SIGKILL'); } catch (error) { failure ??= error; }
    }, context.limits.killGraceMs);
  };
  const rejectProtocol = (error) => { failure ??= error; stop(); };
  const abort = () => { failure ??= context.signal.reason; stop(); };
  // Observe stream termination before waiting for process exit. `close` can
  // replace `end` when a pipe is destroyed during cancellation or a read error.
  const stdoutEnded = new Promise((resolve) => {
    child.stdout.once('end', resolve);
    child.stdout.once('close', resolve);
    child.stdout.once('error', () => { rejectProtocol(new TranscriptionError('sidecar_protocol')); resolve(); });
  });
  child.stderr.on('error', () => rejectProtocol(new TranscriptionError('sidecar_failed')));
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  let stdoutBytes = 0;
  let line = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const consume = (text) => {
    line += text;
    let newline;
    while ((newline = line.indexOf('\n')) >= 0) {
      const value = line.slice(0, newline).replace(/\r$/, '');
      line = line.slice(newline + 1);
      check(value.length > 0);
      check(Buffer.byteLength(value) <= context.limits.maxLineBytes, 'output_limit');
      const parsed = JSON.parse(value);
      if (object(parsed) && parsed.type === 'error') {
        const code = {
          model_not_installed: 'model_missing', engine_unavailable: 'engine_unavailable',
          unsupported_language: 'language_unsupported',
          input_too_large: 'input_limit', input_not_found: 'input_invalid',
          input_unreadable: 'input_invalid', input_empty: 'input_invalid',
          input_format: 'input_invalid', invalid_range: 'input_invalid',
          permission_denied: 'resource_unavailable', write_failed: 'resource_unavailable',
        };
        fail(Object.hasOwn(code, parsed.code) ? code[parsed.code] : 'sidecar_failed');
      }
      onValue(parsed);
    }
    check(Buffer.byteLength(line) <= context.limits.maxLineBytes, 'output_limit');
  };
  child.stdout.on('data', (data) => {
    if (failure) return;
    try {
      stdoutBytes += data.length;
      context.outputBytes += data.length;
      check(stdoutBytes <= context.limits.maxOutputBytes && context.outputBytes <= context.limits.maxOutputBytes, 'output_limit');
      consume(decoder.decode(data, { stream: true }));
    } catch (error) { rejectProtocol(error instanceof TranscriptionError ? error : new TranscriptionError('sidecar_protocol')); }
  });
  child.stderr.on('data', () => {});
  const code = await new Promise((resolve) => {
    child.once('error', () => { failure ??= new TranscriptionError('sidecar_unavailable'); resolve(null); });
    // Kill descendants on exit too, before inherited pipes can keep `close` pending.
    child.once('exit', (exitCode) => {
      try { signalGroup(child.pid, 'SIGKILL'); } catch (error) { failure ??= error; }
      resolve(exitCode);
    });
  });
  try {
    await stdoutEnded;
    if (!failure) {
      try { consume(decoder.decode()); check(line === ''); }
      catch { failure = new TranscriptionError('sidecar_protocol'); }
    }
    // Preserve the first terminal cause, including one received before an
    // abort/deadline that fires while TERM-resistant processes are reaped.
    if (failure) throw failure;
    context.assertActive();
    check(code === 0, 'sidecar_failed');
  } finally {
    clearTimeout(killTimer);
    context.signal.removeEventListener('abort', abort);
    signalGroup(child.pid, 'SIGKILL');
  }
}

async function oneValue(binary, args, context) {
  const values = [];
  await command(binary, args, context, (value) => { check(object(value) && values.length === 0); values.push(value); });
  check(values.length === 1);
  return values[0];
}

async function copyInput(inputPath, context) {
  const source = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const info = await source.stat();
    check(info.isFile() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'input_not_private');
    await ensurePrivateAcl(inputPath, 'input_not_private', { expectedStat: info });
    check(info.size > 0 && info.size <= context.limits.maxInputBytes, 'input_limit');
    const format = await audioFormat(source, info.size, context.assertActive);
    check(format, 'input_format');
    check(BigInt(info.size + Math.ceil(context.limits.maxDurationSec * 32000) + 44
      + context.limits.maxSpeakerMapBytes + context.limits.minFreeBytes) <= await diskAvailable(context.workspace), 'disk_limit');
    // AVFoundation can use the container extension when selecting its reader.
    // Derive it only from the inspected bytes, never the caller's filename.
    const destination = join(context.workspace, `input.${format}`);
    output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      context.assertActive();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      check(size <= context.limits.maxInputBytes, 'input_limit');
      hash.update(buffer.subarray(0, bytesRead));
      // FileHandle.write can write fewer bytes than requested.
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
        check(bytesWritten > 0, 'input_unreadable');
        offset += bytesWritten;
      }
    }
    check(size > 0 && size === info.size, 'input_changed');
    const after = await source.stat();
    check(after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'input_changed');
    return { path: destination, source: { sha256: hash.digest('hex'), bytes: size, format } };
  } finally {
    await output?.close();
    await source.close();
  }
}

/**
 * One already-downloaded, user-owned private audio file -> in-memory result.
 * No network, persistence, logging, API transport, or model download. The caller
 * retains ownership of inputPath; only this attempt's private copy is removed.
 */
export function transcribeAudio(options) {
  return attempt(options, false);
}

/** Read-only runtime/model check; does not install models or decide service mode. */
export function preflightSpeech(options) {
  return attempt(options, true);
}

async function attempt({ inputPath, sidecarPath, workRoot, signal, language = 'ja', speakerMode = 'none', limits: overrides, expectedSource } = {}, preflight) {
  let workspace;
  let timer;
  let monitor;
  let checking;
  const controller = new AbortController();
  const abort = () => controller.abort(new TranscriptionError('cancelled'));
  try {
    const osRelease = release();
    check(process.platform === 'darwin' && process.arch === 'arm64' && /^\d+\./.test(osRelease) && Number(osRelease.split('.')[0]) >= 25, 'unsupported_platform');
    check((preflight ? [sidecarPath, workRoot] : [inputPath, sidecarPath, workRoot]).every((p) => typeof p === 'string' && isAbsolute(p)), 'invalid_configuration');
    check(signal === undefined || signal instanceof AbortSignal, 'invalid_configuration');
    check(typeof language === 'string' && /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(language), 'invalid_configuration');
    check(['auto', 'none', '2', '3', '4plus'].includes(speakerMode), 'invalid_configuration');
    const limits = limitsFor(overrides);
    const snapshot = expectedSource === undefined ? undefined : validateAudioSnapshot(expectedSource);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const assertActive = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    assertActive();
    timer = setTimeout(() => controller.abort(new TranscriptionError('timeout')), limits.timeoutMs);
    // Reject a symlink root and enforce a dedicated private root, never chmod a caller's public directory.
    const root = await lstat(workRoot);
    check(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o077) === 0 && root.uid === process.getuid(), 'workspace_invalid');
    await ensurePrivateAcl(workRoot, 'workspace_invalid', { expectedStat: root });
    workspace = await mkdtemp(join(await realpath(workRoot), 'attempt-'));
    await chmod(workspace, 0o700);
    await ensurePrivateAcl(workspace, 'workspace_invalid', { normalize: true });
    const workspaceInfo = await lstat(workspace);
    check(workspaceInfo.isDirectory() && !workspaceInfo.isSymbolicLink()
      && workspaceInfo.uid === process.getuid() && (workspaceInfo.mode & 0o777) === 0o700, 'workspace_invalid');
    const context = { workspace, limits, signal: controller.signal, assertActive, outputBytes: 0 };
    const checkResources = async () => {
      check(await workspaceBytes(workspace) <= limits.maxWorkspaceBytes, 'workspace_limit');
      check(await diskAvailable(workspace) >= BigInt(limits.minFreeBytes), 'disk_limit');
    };
    monitor = setInterval(() => {
      if (checking) return;
      checking = checkResources().catch((error) => controller.abort(error instanceof TranscriptionError ? error : new TranscriptionError('workspace_invalid'))).finally(() => { checking = undefined; });
    }, limits.monitorMs);
    const copied = preflight ? undefined : await copyInput(inputPath, context);
    const input = copied?.path;
    const source = copied?.source;
    if (!preflight && snapshot) verifyAudioSnapshot(snapshot, source);
    await checkResources();
    const version = await oneValue(sidecarPath, ['version'], context);
    check(version.name === 'niho-speech' && typeof version.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version.version));
    if (preflight) {
      const probe = await oneValue(sidecarPath, ['probe', '--language', language], context);
      check(typeof probe.available === 'boolean' && typeof probe.needsDownload === 'boolean' && probe.engine === 'SpeechAnalyzer');
      check(object(probe.diarization) && probe.diarization.state === 'ready'
        && (probe.diarization.detail === null || typeof probe.diarization.detail === 'string'));
      check(probe.available, 'engine_unavailable');
      check(!probe.needsDownload, 'model_missing');
      check(typeof probe.locale === 'string' && /^[a-z]{2,3}_[A-Z]{2}$/.test(probe.locale) && probe.locale.split('_')[0] === language.split(/[-_]/)[0]);
      await checkResources();
      assertActive();
      return {
        platform: { os: process.platform, arch: process.arch, release: osRelease },
        engine: { name: probe.engine, sidecar: version.name, version: version.version },
        language, locale: probe.locale, available: probe.available, needsDownload: probe.needsDownload,
      };
    }
    const wav = join(workspace, 'audio.wav');
    const converted = await oneValue(sidecarPath, ['convert', '--input', input, '--output', wav], context);
    const durationSec = converted.durationSec;
    check(number(durationSec) && durationSec > 0);
    check(durationSec <= limits.maxDurationSec, 'duration_limit');
    const wavInfo = await lstat(wav);
    check(wavInfo.isFile() && !wavInfo.isSymbolicLink() && wavInfo.uid === process.getuid() && (wavInfo.mode & 0o077) === 0, 'workspace_invalid');
    check(wavInfo.size >= 44 && wavInfo.size <= Math.ceil(limits.maxDurationSec * 32000) + 44, 'workspace_limit');
    await checkResources();
    let speakerMap;
    if (speakerMode !== 'none') {
      speakerMap = join(workspace, 'speakers.json');
      const args = ['diarize', '--input', wav, '--output', speakerMap];
      if (speakerMode === '2' || speakerMode === '3') args.push('--speakers', speakerMode);
      else if (speakerMode === '4plus') args.push('--minimum-speakers', '4');
      const diarized = await oneValue(sidecarPath, args, context);
      check(diarized.ok === true && integer(diarized.turns));
      let mapInfo;
      try { mapInfo = await lstat(speakerMap); }
      catch { fail('sidecar_protocol'); }
      check(mapInfo.isFile() && !mapInfo.isSymbolicLink() && mapInfo.uid === process.getuid() && (mapInfo.mode & 0o077) === 0, 'workspace_invalid');
      check(mapInfo.size > 0 && mapInfo.size <= limits.maxSpeakerMapBytes, 'workspace_limit');
      await checkResources();
    }
    const silence = await oneValue(sidecarPath, ['silence', '--input', wav, '--target', '900', '--window', '60', '--min', '60'], context);
    check(number(silence.durationSec) && Math.abs(silence.durationSec - durationSec) <= 0.01 && Array.isArray(silence.cuts));
    check(silence.cuts.length < limits.maxChunks, 'output_limit');
    const points = [0];
    for (const cut of silence.cuts) {
      check(number(cut) && cut > points.at(-1) && cut < durationSec);
      points.push(cut);
    }
    points.push(durationSec);
    const segments = [];
    const markdown = markdownCollector(limits.maxCandidateBytes, { speakers: speakerMode !== 'none' });
    let processingMs = 0;
    for (let i = 0; i < points.length - 1; i++) {
      let done = false;
      let count = 0;
      let lastStart = points[i];
      const transcribeArgs = ['transcribe', '--input', wav, '--language', language, '--start', String(points[i]), '--end', String(points[i + 1])];
      if (speakerMap) transcribeArgs.push('--speaker-map', speakerMap);
      await command(sidecarPath, transcribeArgs, context, (value) => {
        check(object(value) && !done);
        if (value.type === 'segment') {
          check(number(value.start) && number(value.end) && value.start >= points[i] && value.start >= lastStart && value.end >= value.start && value.end <= points[i + 1] + 0.01 && typeof value.text === 'string');
          if (speakerMode === 'none') check(!('speaker' in value));
          else check(Object.hasOwn(value, 'speaker') && (value.speaker === null || Number.isSafeInteger(value.speaker) && value.speaker > 0));
          check(segments.length < limits.maxSegments, 'output_limit');
          markdown.append(value);
          segments.push({ start: value.start, end: value.end, text: value.text, ...(speakerMode === 'none' ? {} : { speaker: value.speaker }) });
          lastStart = value.start;
          count++;
        } else if (value.type === 'progress') {
          check(number(value.ratio) && value.ratio >= 0 && value.ratio <= 1);
        } else if (value.type === 'done') {
          check(integer(value.segments) && value.segments === count && integer(value.durationMs));
          processingMs += value.durationMs;
          check(Number.isSafeInteger(processingMs));
          done = true;
        } else fail('sidecar_protocol');
      });
      check(done);
    }
    await checkResources();
    assertActive();
    check(markdown.hasText, 'silent_audio');
    return {
      source,
      engine: { name: 'SpeechAnalyzer', sidecar: version.name, version: version.version },
      durationSec,
      processingMs,
      segments,
      markdown: markdown.text(),
    };
  } catch (error) {
    throw error instanceof TranscriptionError ? error : new TranscriptionError('transcription_failed');
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    if (signal instanceof AbortSignal) signal.removeEventListener('abort', abort);
    await checking;
    if (workspace) {
      try { await rm(workspace, { recursive: true, force: true }); }
      catch { throw new TranscriptionError('workspace_cleanup_failed'); }
    }
  }
}

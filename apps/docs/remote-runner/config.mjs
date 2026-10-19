import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';

import { ensurePrivateAcl } from './acl.mjs';
import { RunnerError } from './runner-errors.mjs';

export const API_ORIGINS = Object.freeze({
  prod: 'https://niho.life',
  stg: 'https://app-stg.niho.life',
});

const CONFIG_KEYS = new Set([
  'environment', 'runnerId', 'sidecarPath', 'workRoot', 'languages',
  'idlePollMs', 'heartbeatMs', 'maxIdlePollMs',
]);

// 共有 Mac が文字起こしする言語（API の録音の言語と同じ）。並びは API が返す順（ja を先）に揃える。
export const SPEECH_LANGUAGES = Object.freeze(['ja', 'en']);

// `languages`（例: ["ja","en"]）。重複のない 1〜2 件。
function configuredLanguages(raw) {
  const value = raw.languages;
  if (!Array.isArray(value) || value.length < 1 || value.length > SPEECH_LANGUAGES.length
    || value.some((language) => !SPEECH_LANGUAGES.includes(language)) || new Set(value).size !== value.length) return undefined;
  return Object.freeze(SPEECH_LANGUAGES.filter((language) => value.includes(language)));
}

async function privatePath(path, kind) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new RunnerError('invalid_configuration');
  try {
    const info = await lstat(path);
    const correctKind = kind === 'file' ? info.isFile() : info.isDirectory();
    const expectedMode = kind === 'file' ? 0o600 : 0o700;
    if (!correctKind || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & 0o777) !== expectedMode) throw new Error('unsafe');
    await ensurePrivateAcl(path, 'private_configuration_invalid', { expectedStat: info });
    return info;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('private_configuration_invalid');
  }
}

async function readPrivateFile(path, maxBytes) {
  await privatePath(dirname(path), 'directory');
  const expected = await privatePath(path, 'file');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size < 1 || actual.size > maxBytes) {
      throw new Error('changed');
    }
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    throw new RunnerError('private_configuration_invalid');
  } finally {
    await handle?.close();
  }
}

function integerIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export async function loadRunnerConfig({ configPath, credentialPath } = {}) {
  const [configText, credentialText] = await Promise.all([
    readPrivateFile(configPath, 16 * 1024),
    readPrivateFile(credentialPath, 1024),
  ]);
  let raw;
  try { raw = JSON.parse(configText); }
  catch { throw new RunnerError('invalid_configuration'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !CONFIG_KEYS.has(key))) {
    throw new RunnerError('invalid_configuration');
  }
  const environment = raw.environment;
  const runnerId = raw.runnerId;
  const languages = configuredLanguages(raw);
  if (!Object.hasOwn(API_ORIGINS, environment)
    || typeof runnerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(runnerId)
    || !languages
    || typeof raw.sidecarPath !== 'string' || !isAbsolute(raw.sidecarPath)
    || typeof raw.workRoot !== 'string' || !isAbsolute(raw.workRoot)) {
    throw new RunnerError('invalid_configuration');
  }
  await privatePath(raw.workRoot, 'directory');
  const idlePollMs = raw.idlePollMs ?? 5_000;
  const maxIdlePollMs = raw.maxIdlePollMs ?? 60_000;
  const heartbeatMs = raw.heartbeatMs ?? 30_000;
  if (!integerIn(idlePollMs, 250, 60_000)
    || !integerIn(maxIdlePollMs, idlePollMs, 60_000)
    || !integerIn(heartbeatMs, 1_000, 60_000)) {
    throw new RunnerError('invalid_configuration');
  }
  // R2's docs-runner-credential.mjs is the sole provisioning format.
  let credential;
  try { credential = JSON.parse(credentialText); }
  catch { throw new RunnerError('invalid_credential'); }
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)
    || Object.keys(credential).length !== 2 || credential.runnerId !== runnerId
    || typeof credential.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential.secret)) {
    throw new RunnerError('invalid_credential');
  }
  const secret = credential.secret;
  return Object.freeze({
    environment, apiOrigin: API_ORIGINS[environment], runnerId, secret,
    sidecarPath: raw.sidecarPath, workRoot: raw.workRoot, languages,
    idlePollMs, maxIdlePollMs, heartbeatMs,
  });
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== '--config' || argv[2] !== '--credential'
    || !isAbsolute(argv[1]) || !isAbsolute(argv[3])) {
    throw new RunnerError('invalid_arguments');
  }
  return { configPath: argv[1], credentialPath: argv[3] };
}

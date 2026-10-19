import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ensurePrivateAcl } from './acl.mjs';
import { cleanupStaleAttempts } from './cleanup.mjs';
import { DEFAULT_LIMITS, diskAvailable, preflightSpeech } from './engine.mjs';
import { createDocsRunnerClient, downloadSignedInput, uploadSignedCandidate } from './http-client.mjs';
import { transcribeRecording } from './recording.mjs';
import { RunnerError, runnerError } from './runner-errors.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PAUSE_CODES = new Set([
  'model_missing', 'engine_unavailable', 'resource_unavailable',
  'disk_limit', 'workspace_limit', 'workspace_invalid',
  'workspace_cleanup_failed', 'process_cleanup_failed',
]);
const PASSIVE_CLAIM_STATES = new Set(['RESULT_UNKNOWN', 'FAILED', 'INPUT_CHANGED', 'INPUT_EXPIRED']);

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new RunnerError('cancelled'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal.reason ?? new RunnerError('cancelled'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function safeLog(logger, event, fields = {}) {
  const allowed = {};
  for (const key of ['runnerId', 'attemptId', 'generation', 'phase', 'code', 'count', 'removedAttempts', 'skippedEntries', 'languages']) {
    const value = fields[key];
    if (typeof value === 'string' || Number.isSafeInteger(value)) allowed[key] = value;
  }
  logger?.({ event, ...allowed });
}

function heartbeatLoop({ client, claim, controller, heartbeatMs, clock, delay }) {
  const stopController = new AbortController();
  let failure;
  let expiresAt = Date.parse(claim.expiresAt);
  let expiryTimer;
  let loopStopped = false;
  let receiptAccepted = false;
  const combined = AbortSignal.any([controller.signal, stopController.signal]);
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    const remaining = expiresAt - clock();
    if (remaining <= 0) {
      failure = new RunnerError('attempt_expired', { fatal: true });
      controller.abort(failure);
      return;
    }
    expiryTimer = setTimeout(() => {
      failure = new RunnerError('attempt_expired', { fatal: true });
      controller.abort(failure);
    }, Math.min(remaining, 2_147_483_647));
  };
  scheduleExpiry();
  const pending = (async () => {
    while (!combined.aborted) {
      try { await delay(heartbeatMs, combined); }
      catch { break; }
      if (combined.aborted) break;
      try {
        const result = await client.heartbeat(claim, combined);
        const next = Date.parse(result.expiresAt);
        if (!Number.isFinite(next) || next <= clock()) throw new RunnerError('heartbeat_rejected');
        expiresAt = next;
        scheduleExpiry();
      } catch (error) {
        if (stopController.signal.aborted || controller.signal.aborted) break;
        const source = error instanceof RunnerError
          ? error
          : new RunnerError('heartbeat_unknown', { outcomeUnknown: true });
        failure = new RunnerError(source.code, { fatal: true, outcomeUnknown: source.outcomeUnknown });
        controller.abort(failure);
        break;
      }
    }
  })();
  const stopLoop = async () => {
    if (loopStopped) return;
    loopStopped = true;
    stopController.abort(new RunnerError('heartbeat_stopped'));
    await pending;
    if (failure) throw failure;
  };
  const updateExpiry = (result) => {
    const next = Date.parse(result.expiresAt);
    if (!Number.isFinite(next) || next <= clock()) throw new RunnerError('heartbeat_rejected');
    expiresAt = next;
    scheduleExpiry();
  };
  // 認証済みの heartbeat を 1 回送り、lease の期限を今の値へ取り直す。失敗は致命（結果不明を含む）として attempt を止める。
  const heartbeatNow = async () => {
    try {
      updateExpiry(await client.heartbeat(claim, controller.signal));
    } catch (error) {
      const source = error instanceof RunnerError
        ? error
        : new RunnerError('heartbeat_unknown', { outcomeUnknown: true });
      failure = new RunnerError(source.code, { fatal: true, outcomeUnknown: source.outcomeUnknown });
      controller.abort(failure);
      throw failure;
    }
  };
  return {
    assertActive() {
      if (failure) throw failure;
      if (controller.signal.aborted) throw controller.signal.reason ?? new RunnerError('cancelled');
      if (!Number.isFinite(expiresAt) || expiresAt <= clock()) {
        const error = new RunnerError('attempt_expired');
        controller.abort(error);
        throw error;
      }
    },
    expiresAt: () => expiresAt,
    /**
     * 並行する heartbeat が API で延長を commit していても、その応答がまだ処理されていないと、手元の期限は古いまま。
     * candidate の URL の期限（API が grant の期限で切る）が手元の期限を超えたときに、認証済みの期限へ取り直す。
     */
    async sync() {
      this.assertActive();
      await heartbeatNow();
      this.assertActive();
    },
    async prepareSubmit() {
      await stopLoop();
      this.assertActive();
      await heartbeatNow();
      this.assertActive();
    },
    acceptReceipt() {
      receiptAccepted = true;
      clearTimeout(expiryTimer);
    },
    async stop() {
      try { await stopLoop(); }
      finally { clearTimeout(expiryTimer); }
      if (failure && !receiptAccepted) throw failure;
    },
    failure: () => failure,
  };
}

async function stagingDirectory(workRoot) {
  let path;
  try {
    path = await mkdtemp(join(await realpath(workRoot), 'attempt-'));
    await chmod(path, 0o700);
    await ensurePrivateAcl(path, 'workspace_invalid', { normalize: true });
    return path;
  } catch (error) {
    if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareRunner({ config, lock, signal, preflight = preflightSpeech, logger } = {}) {
  if (!lock || typeof lock.assertHeld !== 'function') throw new RunnerError('runner_lock_invalid', { fatal: true });
  await lock.assertHeld();
  const cleanup = await cleanupStaleAttempts({ workRoot: config.workRoot, singleInstanceConfirmed: true });
  safeLog(logger, 'startup_cleanup', cleanup);
  if (cleanup.activeAttempts) throw new RunnerError('workspace_active', { fatal: true });
  // 設定した言語ごとにモデルを確かめる。1 つでも欠ければ起動しない（自動では取得しない。runbook の手順で運用者が入れる）。
  const readiness = [];
  for (const language of config.languages) {
    const ready = await preflight({ sidecarPath: config.sidecarPath, workRoot: config.workRoot, language, signal });
    if (ready?.language !== language || ready.available !== true || ready.needsDownload !== false) {
      throw new RunnerError('preflight_failed', { fatal: true });
    }
    readiness.push(ready);
  }
  safeLog(logger, 'preflight_ready', { runnerId: config.runnerId, languages: config.languages.join(',') });
  return Object.freeze(readiness);
}

/**
 * 入力を落とす前に、置き場に入るかを確かめる。全入力（stage）+ 最大の 1 本の作業コピー + 復号 WAV の上限 + 余白で、
 * engine.mjs の copyInput が 1 本ごとに使う見積りと同じ。足りなければ 2 GiB を落としてから失敗にせず `disk_limit` で止める。
 * 話者分離を使わない claim でも安全側に speaker map の上限分を予約する。
 */
export async function assertDiskForInputs(workRoot, inputs) {
  const total = inputs.reduce((sum, input) => sum + input.bytes, 0);
  const largest = inputs.reduce((max, input) => Math.max(max, input.bytes), 0);
  const needed = BigInt(total + largest + Math.ceil(DEFAULT_LIMITS.maxDurationSec * 32000) + 44
    + DEFAULT_LIMITS.maxSpeakerMapBytes + DEFAULT_LIMITS.minFreeBytes);
  if (needed > await diskAvailable(workRoot)) throw new RunnerError('disk_limit');
}

export async function processClaim({
  claim, client, config, signal, logger,
  transcribe = transcribeRecording,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  delay = abortableDelay,
} = {}) {
  if (!claim || claim.status !== 'LEASED') throw new RunnerError('api_protocol');
  if (!config.languages.includes(claim.language)) throw new RunnerError('claim_language_mismatch', { fatal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason ?? new RunnerError('cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const heartbeat = heartbeatLoop({ client, claim, controller, heartbeatMs: config.heartbeatMs, clock, delay });
  let stage;
  let phase = 'download';
  let primaryError;
  let heartbeatStopped = false;
  const stopHeartbeat = async () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    await heartbeat.stop();
  };
  safeLog(logger, 'attempt_started', { runnerId: config.runnerId, attemptId: claim.attemptId, generation: claim.generation, phase });
  try {
    heartbeat.assertActive();
    stage = await stagingDirectory(config.workRoot);
    await assertDiskForInputs(config.workRoot, claim.inputs);
    const audio = [];
    for (let index = 0; index < claim.inputs.length; index++) {
      heartbeat.assertActive();
      const expected = claim.inputs[index];
      const descriptor = await client.input(claim, expected, controller.signal);
      heartbeat.assertActive();
      if (Date.parse(descriptor.expiresAt) <= clock() || Date.parse(descriptor.expiresAt) > heartbeat.expiresAt()) {
        throw new RunnerError('input_url_expired');
      }
      const inputPath = join(stage, `input-${String(index + 1).padStart(2, '0')}.audio`);
      await downloadSignedInput({ descriptor, expected, destination: inputPath, fetchImpl, signal: controller.signal });
      audio.push({ inputPath, snapshot: { sha256: expected.sha256, bytes: expected.bytes } });
    }

    phase = 'transcribe';
    safeLog(logger, 'attempt_phase', { attemptId: claim.attemptId, generation: claim.generation, phase });
    heartbeat.assertActive();
    const result = await transcribe({
      audio, sidecarPath: config.sidecarPath, workRoot: config.workRoot,
      signal: controller.signal, language: claim.language, speakerMode: claim.speakerMode,
    });
    heartbeat.assertActive();
    const candidate = Buffer.from(result.markdown, 'utf8');
    if (!result.candidate || result.candidate.bytes !== candidate.length
      || result.candidate.sha256 !== sha256(candidate) || candidate.length < 1) {
      throw new RunnerError('candidate_integrity_mismatch');
    }

    phase = 'candidate';
    safeLog(logger, 'attempt_phase', { attemptId: claim.attemptId, generation: claim.generation, phase });
    const reservation = await client.candidate(claim, candidate.length, controller.signal);
    heartbeat.assertActive();
    const uploadExpiresAt = Date.parse(reservation.expiresAt);
    if (!Number.isFinite(uploadExpiresAt) || uploadExpiresAt <= clock()) throw new RunnerError('candidate_expired');
    // PUT の URL は lease の期限を超えてはならない。API は grant の期限（並行する heartbeat の延長を含む）で切るので、その応答が
    // 手元に届く前に candidate が先に届いたときは、認証済みの期限を取り直してから照らす
    if (uploadExpiresAt > heartbeat.expiresAt()) await heartbeat.sync();
    if (uploadExpiresAt > heartbeat.expiresAt()) throw new RunnerError('candidate_expired');

    phase = 'upload';
    safeLog(logger, 'attempt_phase', { attemptId: claim.attemptId, generation: claim.generation, phase });
    await uploadSignedCandidate({ reservation, bytes: candidate, fetchImpl, signal: controller.signal });
    heartbeat.assertActive();

    phase = 'final_heartbeat';
    safeLog(logger, 'attempt_phase', { attemptId: claim.attemptId, generation: claim.generation, phase });
    await heartbeat.prepareSubmit();

    // 端末内の SpeechAnalyzer は外部AIの有料送信ではないので dispatch は呼ばない（README・runbook と同じ。回収経路も同じ）。
    phase = 'submit';
    safeLog(logger, 'attempt_phase', { attemptId: claim.attemptId, generation: claim.generation, phase });
    const receipt = await client.submit(claim, controller.signal);
    heartbeat.acceptReceipt();
    heartbeatStopped = true;
    safeLog(logger, 'attempt_completed', { attemptId: claim.attemptId, generation: claim.generation });
    return receipt;
  } catch (caught) {
    let error = runnerError(caught, 'attempt_failed');
    primaryError = error;
    const safeToFail = phase === 'download' || phase === 'transcribe';
    const cancelled = signal?.aborted || error.code === 'cancelled';
    try { await stopHeartbeat(); }
    catch (heartbeatError) { error = heartbeatError; }
    if (safeToFail && !cancelled && !error.fatal && !error.outcomeUnknown && !heartbeat.failure()) {
      try { await client.fail(claim, controller.signal); }
      catch (failError) { error = failError; }
    }
    if (PAUSE_CODES.has(error.code) && !error.fatal) {
      error = new RunnerError(error.code, { fatal: true });
    }
    if (!safeToFail && !cancelled && !error.fatal) {
      error = new RunnerError(error.code, { fatal: true, outcomeUnknown: error.outcomeUnknown });
    }
    primaryError = error;
    safeLog(logger, 'attempt_failed', { attemptId: claim.attemptId, generation: claim.generation, phase, code: error.code });
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    controller.abort(new RunnerError('cancelled'));
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    catch {
      // 音声を含む作業場所を残したまま次の claim へ進まない。先に失敗していても（非 fatal でも）止める
      safeLog(logger, 'workspace_cleanup_failed', { attemptId: claim.attemptId, generation: claim.generation, code: primaryError?.code });
      throw new RunnerError('workspace_cleanup_failed', { fatal: true });
    }
  }
}

export async function recoverClaim({ claim, client, signal, logger, clock = Date.now }) {
  safeLog(logger, 'attempt_recovery_started', { attemptId: claim.attemptId, generation: claim.generation });
  const outcome = await client.outcome(claim, signal);
  if (outcome.receipt) {
    safeLog(logger, 'attempt_recovery_completed', { attemptId: claim.attemptId, generation: claim.generation });
    return outcome.receipt;
  }
  if (!outcome.candidate || outcome.candidate.candidateId !== claim.candidateId || outcome.candidate.state !== 'RESERVED'
    || Date.parse(outcome.candidate.expiresAt) <= clock()) {
    throw new RunnerError('candidate_recovery_unavailable', { fatal: true });
  }
  const receipt = await client.submit(claim, signal);
  safeLog(logger, 'attempt_recovery_completed', { attemptId: claim.attemptId, generation: claim.generation });
  return receipt;
}

export async function runPollingService({
  client, config, signal, logger,
  transcribe, fetchImpl, clock = Date.now, delay = abortableDelay,
  maxConsecutivePollErrors = 3,
} = {}) {
  let idleDelay = config.idlePollMs;
  let pollErrors = 0;
  let completed = 0;
  while (!signal?.aborted) {
    let claim;
    try {
      claim = await client.claim(signal);
      pollErrors = 0;
    } catch (caught) {
      const error = runnerError(caught, 'poll_failed');
      safeLog(logger, 'poll_failed', { runnerId: config.runnerId, code: error.code, count: pollErrors + 1 });
      if (error.fatal || ++pollErrors >= maxConsecutivePollErrors) {
        throw error.fatal ? error : new RunnerError('poll_retry_exhausted', { fatal: true });
      }
      await delay(Math.min(config.maxIdlePollMs, config.idlePollMs * 2 ** (pollErrors - 1)), signal);
      continue;
    }
    if (claim.status === 'IDLE' || claim.status === 'WAITING_CAPACITY') {
      safeLog(logger, 'poll_idle', { runnerId: config.runnerId });
      await delay(idleDelay, signal);
      idleDelay = Math.min(config.maxIdlePollMs, idleDelay * 2);
      continue;
    }
    if (PASSIVE_CLAIM_STATES.has(claim.status)) {
      safeLog(logger, 'poll_terminal', { runnerId: config.runnerId, code: claim.status.toLowerCase() });
      continue;
    }
    if (claim.status === 'RECOVERY') {
      idleDelay = config.idlePollMs;
      try {
        await recoverClaim({ claim, client, signal, logger, clock });
        completed++;
      } catch (caught) {
        const error = runnerError(caught, 'candidate_recovery_failed');
        if (error.fatal || error.outcomeUnknown) throw error;
      }
      continue;
    }
    if (claim.status !== 'LEASED') throw new RunnerError('api_protocol', { fatal: true });
    idleDelay = config.idlePollMs;
    try {
      await processClaim({ claim, client, config, signal, logger, transcribe, fetchImpl, clock, delay });
      completed++;
    } catch (caught) {
      const error = runnerError(caught, 'attempt_failed');
      if (error.fatal || error.outcomeUnknown) throw error;
    }
  }
  return { completed };
}

export async function runConfiguredService({
  config, lock, signal, logger, preflight = preflightSpeech,
  fetchImpl = globalThis.fetch, transcribe, clock = Date.now, delay = abortableDelay,
} = {}) {
  const serviceSignal = lock?.signal ? AbortSignal.any([signal, lock.signal].filter(Boolean)) : signal;
  await prepareRunner({ config, lock, signal: serviceSignal, preflight, logger });
  const client = createDocsRunnerClient({ ...config, fetchImpl });
  return runPollingService({ client, config, signal: serviceSignal, logger, transcribe, fetchImpl, clock, delay });
}

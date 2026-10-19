import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';

import { API_ORIGINS, SPEECH_LANGUAGES } from './config.mjs';
import { RunnerError } from './runner-errors.mjs';

const API_PREFIX = '/api/internal/docs-runner';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS = 2 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9][0-9]{0,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUTATING = new Set(['claim', 'candidate', 'dispatch', 'submit', 'fail']);
const WAIT_REASONS = new Set(['attempt_held', 'vault_lease_held']);
// submit が返す run の状態（apps/api/src/ops/docs-runs.ts の submit）。これ以外は確定していないので submit 結果不明として止める
const SUBMIT_STATES = new Set(['SUCCEEDED', 'TRANSCRIPTION_COMPLETE', 'INPUT_CHANGED', 'QUEUED', 'WAITING_PC', 'WAITING_STORAGE']);
const GCS_REQUIRED_QUERY = [
  'X-Goog-Algorithm', 'X-Goog-Credential', 'X-Goog-Date',
  'X-Goog-Expires', 'X-Goog-SignedHeaders', 'X-Goog-Signature',
];
const CANDIDATE_SIGNED_HEADERS = 'content-type;host;x-goog-content-length-range;x-goog-if-generation-match';

// Symbol keys cannot arrive from JSON config. Tests may only shorten deadlines.
export const TEST_ONLY_TIMEOUTS = Symbol('docs-runner-test-only-timeouts');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function expect(ok, code = 'api_protocol') {
  if (!ok) throw new RunnerError(code);
}

function timeoutFor(options, key, maximum) {
  const value = options?.[TEST_ONLY_TIMEOUTS]?.[key] ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RunnerError('invalid_configuration');
  return value;
}

function operationSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RunnerError('deadline_exceeded')), timeoutMs);
  const externalAbort = () => {
    clearTimeout(timer);
    controller.abort(signal.reason ?? new RunnerError('cancelled'));
  };
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', externalAbort);
    },
  };
}

function raceWithSignal(value, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new RunnerError('cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal?.removeEventListener('abort', aborted);
      reject(signal.reason ?? new RunnerError('cancelled'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then((result) => {
      signal?.removeEventListener('abort', aborted);
      resolve(result);
    }, (error) => {
      signal?.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

function cancelBody(response, reason) {
  void response?.body?.cancel(reason).catch(() => {});
}

async function consumeBody(response, limit, signal, onChunk) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let size = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) return size;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > limit) throw new RunnerError('response_limit');
      await onChunk(chunk);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof RunnerError) throw error;
    if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
    throw new RunnerError('response_unreadable');
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function boundedBody(response, limit, signal) {
  const chunks = [];
  const size = await consumeBody(response, limit, signal, async (chunk) => { chunks.push(chunk); });
  return Buffer.concat(chunks, size);
}

async function jsonBody(response, signal) {
  const bytes = await boundedBody(response, MAX_JSON_BYTES, signal);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new RunnerError('api_protocol'); }
}

function mutationUnknown(operation) {
  return new RunnerError(`${operation}_outcome_unknown`, { fatal: true, outcomeUnknown: true });
}

function apiStatusError(status, operation) {
  if (status === 401 || status === 403) return new RunnerError('credential_rejected', { fatal: true });
  if (operation === 'heartbeat') return new RunnerError('heartbeat_rejected');
  if (status === 409 || status === 410) return new RunnerError('attempt_rejected');
  if (status >= 500 && MUTATING.has(operation)) return mutationUnknown(operation);
  return new RunnerError('api_unavailable');
}

function claimWaitReason(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return undefined; }
  const reason = value?.error?.details?.reason;
  return typeof reason === 'string' && WAIT_REASONS.has(reason) ? reason : undefined;
}

function validateClaim(value) {
  const passive = new Set(['IDLE', 'RESULT_UNKNOWN', 'FAILED', 'INPUT_CHANGED', 'INPUT_EXPIRED', 'WAITING_CAPACITY']);
  expect(object(value) && (passive.has(value.status) || value.status === 'LEASED' || value.status === 'RECOVERY'));
  if (passive.has(value.status)) {
    expect(exactKeys(value, ['status']));
    return Object.freeze({ status: value.status });
  }
  if (value.status === 'RECOVERY') {
    expect(exactKeys(value, ['status', 'runId', 'attemptId', 'generation', 'candidateId', 'grant', 'expiresAt', 'submitted'])
      && ID.test(value.runId) && ID.test(value.attemptId)
      && Number.isSafeInteger(value.generation) && value.generation > 0
      && UUID.test(value.candidateId) && TOKEN.test(value.grant) && validDate(value.expiresAt)
      && typeof value.submitted === 'boolean');
    return Object.freeze({ ...value });
  }
  expect(exactKeys(value, ['status', 'runId', 'attemptId', 'generation', 'candidateId', 'grant', 'expiresAt', 'language', 'speakerMode', 'inputs'])
    && ID.test(value.runId) && ID.test(value.attemptId)
    && Number.isSafeInteger(value.generation) && value.generation > 0
    && UUID.test(value.candidateId) && TOKEN.test(value.grant) && validDate(value.expiresAt)
    && (value.language === 'ja' || value.language === 'en')
    && ['auto', 'none', '2', '3', '4plus'].includes(value.speakerMode)
    && Array.isArray(value.inputs) && value.inputs.length > 0 && value.inputs.length <= 12);
  const inputs = value.inputs.map((entry) => {
    expect(exactKeys(entry, ['ordinal', 'checkpointId', 'sha256', 'bytes', 'generation'])
      && Number.isSafeInteger(entry.ordinal) && entry.ordinal >= 0 && entry.ordinal < 12
      && ID.test(entry.checkpointId) && HASH.test(entry.sha256)
      && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 2 * 1024 ** 3
      && GENERATION.test(entry.generation));
    return Object.freeze({ ...entry });
  });
  expect(inputs.every((entry, index) => entry.ordinal === index));
  expect(new Set(inputs.map((entry) => entry.checkpointId)).size === inputs.length);
  return Object.freeze({ ...value, inputs: Object.freeze(inputs) });
}

function validateInput(value, expected) {
  expect(exactKeys(value, ['url', 'expiresAt', 'sha256', 'bytes', 'generation'])
    && typeof value.url === 'string' && validDate(value.expiresAt)
    && value.sha256 === expected.sha256 && value.bytes === expected.bytes
    && value.generation === expected.generation, 'input_snapshot_mismatch');
  validateGcsSignedUrl(value.url, { generation: expected.generation, signedHeaders: 'host' });
  return Object.freeze({ ...value });
}

function validateHeartbeat(value) {
  expect(exactKeys(value, ['expiresAt']) && validDate(value.expiresAt));
  return Object.freeze({ expiresAt: value.expiresAt });
}

function candidateHeaders(value, bytes) {
  expect(object(value));
  const normalized = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const lower = name.toLowerCase();
    expect(name === lower && typeof headerValue === 'string' && !Object.hasOwn(normalized, lower), 'candidate_headers_invalid');
    normalized[lower] = headerValue;
  }
  const expected = {
    'content-type': 'text/markdown',
    'x-goog-if-generation-match': '0',
    'x-goog-content-length-range': `${bytes},${bytes}`,
  };
  expect(exactKeys(normalized, Object.keys(expected))
    && Object.entries(expected).every(([name, expectedValue]) => normalized[name] === expectedValue), 'candidate_headers_invalid');
  return Object.freeze(normalized);
}

function validateCandidate(value, expectedId, bytes) {
  expect(exactKeys(value, ['candidateId', 'url', 'headers', 'expiresAt', 'candidateExpiresAt', 'bytes', 'maxBytes'])
    && value.candidateId === expectedId && UUID.test(value.candidateId)
    && typeof value.url === 'string' && validDate(value.expiresAt) && validDate(value.candidateExpiresAt)
    && Date.parse(value.candidateExpiresAt) >= Date.parse(value.expiresAt)
    && value.bytes === bytes && Number.isSafeInteger(value.maxBytes) && value.maxBytes >= bytes && value.maxBytes <= 8 * 1024 ** 2);
  validateGcsSignedUrl(value.url, { signedHeaders: CANDIDATE_SIGNED_HEADERS });
  return Object.freeze({ ...value, headers: candidateHeaders(value.headers, bytes) });
}

function validateSubmit(value, claim) {
  expect(exactKeys(value, ['runId', 'state', 'candidateId', 'generation'])
    && value.runId === claim.runId && SUBMIT_STATES.has(value.state)
    && value.candidateId === claim.candidateId && value.generation === claim.generation);
  return Object.freeze({ ...value });
}

function validateDispatch(value) {
  expect(exactKeys(value, ['status']) && value.status === 'SUBMITTED');
  return Object.freeze({ status: value.status });
}

function validateOutcome(value, claim) {
  expect(exactKeys(value, ['runId', 'attempt', 'candidate', 'receipt']) && value.runId === claim.runId);
  expect(exactKeys(value.attempt, ['generation', 'state', 'submitted', 'finishedAt'])
    && value.attempt.generation === claim.generation && typeof value.attempt.state === 'string'
    && typeof value.attempt.submitted === 'boolean'
    && (value.attempt.finishedAt === null || validDate(value.attempt.finishedAt)));
  if (value.candidate !== null) {
    expect(exactKeys(value.candidate, ['candidateId', 'state', 'expiresAt', 'sha256', 'bytes'])
      && value.candidate.candidateId === claim.candidateId && validDate(value.candidate.expiresAt)
      && (value.candidate.sha256 === null || HASH.test(value.candidate.sha256))
      && (value.candidate.bytes === null || Number.isSafeInteger(value.candidate.bytes)));
  }
  expect(value.receipt === null || (object(value.receipt)
    && exactKeys(value.receipt, ['state', 'revision', 'versionPath', 'sha256', 'bytes', 'outputConflict'])
    && HASH.test(value.receipt.sha256)));
  return Object.freeze(value);
}

export function validateGcsSignedUrl(raw, { generation, signedHeaders } = {}) {
  let url;
  try { url = new URL(raw); }
  catch { throw new RunnerError('signed_url_invalid'); }
  const host = url.hostname.toLowerCase();
  const gcsHost = host === 'storage.googleapis.com'
    || (/^[a-z0-9][a-z0-9.-]{0,221}[a-z0-9]\.storage\.googleapis\.com$/.test(host) && !host.includes('..'));
  expect(url.protocol === 'https:' && url.port === '' && !url.username && !url.password && !url.hash
    && gcsHost && url.pathname.startsWith('/') && url.pathname.length > 1, 'signed_url_invalid');
  const allowedQuery = new Set(generation === undefined
    ? GCS_REQUIRED_QUERY : [...GCS_REQUIRED_QUERY, 'generation', 'response-content-type']);
  expect([...url.searchParams.keys()].every((key) => allowedQuery.has(key))
    && GCS_REQUIRED_QUERY.every((key) => url.searchParams.getAll(key).length === 1)
    && url.searchParams.get('X-Goog-Algorithm') === 'GOOG4-RSA-SHA256'
    && /^\d{8}T\d{6}Z$/.test(url.searchParams.get('X-Goog-Date'))
    && /^[1-9][0-9]{0,2}$/.test(url.searchParams.get('X-Goog-Expires'))
    && Number(url.searchParams.get('X-Goog-Expires')) <= 900
    && (signedHeaders === undefined || url.searchParams.get('X-Goog-SignedHeaders') === signedHeaders)
    && /^[A-Fa-f0-9]+$/.test(url.searchParams.get('X-Goog-Signature')), 'signed_url_invalid');
  if (generation !== undefined) {
    expect(url.searchParams.getAll('generation').length === 1 && url.searchParams.get('generation') === generation
      && url.searchParams.getAll('response-content-type').length === 1
      && url.searchParams.get('response-content-type') === 'application/octet-stream', 'input_snapshot_mismatch');
  }
  return url;
}

export function createDocsRunnerClient(options) {
  const { apiOrigin, runnerId, secret, languages, fetchImpl = globalThis.fetch } = options ?? {};
  expect(Object.values(API_ORIGINS).includes(apiOrigin), 'invalid_configuration');
  expect(ID.test(runnerId) && TOKEN.test(secret) && typeof fetchImpl === 'function', 'invalid_configuration');
  // languages は loadRunnerConfig が確かめた言語。claim のたびに申告する。
  expect(Array.isArray(languages) && languages.length > 0
    && languages.every((language) => SPEECH_LANGUAGES.includes(language)) && new Set(languages).size === languages.length, 'invalid_configuration');
  const claimBody = Object.freeze({ languages: Object.freeze([...languages]) });
  const apiTimeoutMs = timeoutFor(options, 'apiMs', API_TIMEOUT_MS);
  const authorization = `DocsRunner ${runnerId}:${secret}`;

  async function request(path, { method = 'POST', grant, body, signal, operation, validate }) {
    const headers = { authorization, accept: 'application/json' };
    if (grant !== undefined) {
      expect(TOKEN.test(grant));
      headers['x-docs-grant'] = grant;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
    const deadline = operationSignal(signal, apiTimeoutMs);
    const requestSignal = deadline.signal;
    try {
      let response;
      try {
        response = await raceWithSignal(fetchImpl(`${apiOrigin}${API_PREFIX}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error', signal: requestSignal,
        }), requestSignal);
      } catch {
        // claim は応答が届かなくても再 claim が自分の lease を 409 attempt_held（待機）で返すので、通信の揺らぎは backoff で再試行する
        if (operation === 'claim' && !signal?.aborted) throw new RunnerError('network_unavailable');
        if (MUTATING.has(operation)) throw mutationUnknown(operation);
        if (operation === 'heartbeat') throw new RunnerError('heartbeat_unknown', { fatal: true, outcomeUnknown: true });
        if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
        throw new RunnerError('network_unavailable');
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        cancelBody(response);
        throw new RunnerError('api_redirect_rejected', { fatal: true });
      }
      if (!response.ok) {
        if (operation === 'claim' && response.status === 409) {
          try {
            const bytes = await boundedBody(response, MAX_ERROR_BYTES, requestSignal);
            if (claimWaitReason(bytes)) return Object.freeze({ status: 'WAITING_CAPACITY' });
          } catch { throw mutationUnknown('claim'); }
          throw new RunnerError('claim_rejected', { fatal: true });
        }
        cancelBody(response);
        if (response.status === 401 || response.status === 403) throw apiStatusError(response.status, operation);
        if (operation === 'claim') throw mutationUnknown('claim');
        throw apiStatusError(response.status, operation);
      }
      try {
        return validate(await jsonBody(response, requestSignal));
      } catch (error) {
        if (operation === 'claim' && requestSignal.aborted && !signal?.aborted) throw new RunnerError('network_unavailable');
        if (MUTATING.has(operation)) throw mutationUnknown(operation);
        if (operation === 'heartbeat') throw new RunnerError('heartbeat_unknown', { fatal: true, outcomeUnknown: true });
        if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
        if (requestSignal.aborted) throw new RunnerError('network_unavailable');
        throw error instanceof RunnerError ? error : new RunnerError('api_protocol');
      }
    } finally {
      deadline.clear();
    }
  }

  return Object.freeze({
    // 確かめた言語を毎回申告し、API はその言語の録音だけを割り当てる。
    claim: (signal) => request('/claim', { body: claimBody, signal, operation: 'claim', validate: validateClaim }),
    input: (claim, input, signal) => request(`/inputs/${encodeURIComponent(input.checkpointId)}`, {
      method: 'GET', grant: claim.grant, signal, operation: 'input', validate: (value) => validateInput(value, input),
    }),
    heartbeat: (claim, signal) => request('/heartbeat', {
      grant: claim.grant, body: {}, signal, operation: 'heartbeat', validate: validateHeartbeat,
    }),
    candidate: (claim, bytes, signal) => request('/candidate', {
      grant: claim.grant, body: { bytes }, signal, operation: 'candidate',
      validate: (value) => validateCandidate(value, claim.candidateId, bytes),
    }),
    dispatch: (claim, signal) => request('/dispatch', {
      grant: claim.grant, body: {}, signal, operation: 'dispatch', validate: validateDispatch,
    }),
    submit: (claim, signal) => request('/submit', {
      grant: claim.grant, body: { candidateId: claim.candidateId }, signal, operation: 'submit',
      validate: (value) => validateSubmit(value, claim),
    }),
    outcome: (claim, signal) => request('/outcome', {
      method: 'GET', grant: claim.grant, signal, operation: 'outcome', validate: (value) => validateOutcome(value, claim),
    }),
    fail: (claim, signal) => request('/fail', {
      grant: claim.grant, body: {}, signal, operation: 'fail', validate: (value) => {
        expect(exactKeys(value, ['runId', 'state']) && value.runId === claim.runId
          && typeof value.state === 'string' && value.state.length > 0 && value.state.length <= 64);
        return Object.freeze({ ...value });
      },
    }),
  });
}

/** 2 GiB の入力を置く途中で空きが尽きた（ENOSPC）か、割り当てを超えた（EDQUOT）。 */
function isDiskFull(error) {
  return error?.code === 'ENOSPC' || error?.code === 'EDQUOT';
}

export async function downloadSignedInput(options) {
  const { descriptor, expected, destination, fetchImpl = globalThis.fetch, signal } = options;
  expect(Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= 2 * 1024 ** 3
    && HASH.test(expected.sha256) && GENERATION.test(expected.generation), 'input_snapshot_mismatch');
  expect(validDate(descriptor.expiresAt), 'input_snapshot_mismatch');
  validateGcsSignedUrl(descriptor.url, { generation: expected.generation, signedHeaders: 'host' });
  const remaining = Date.parse(descriptor.expiresAt) - Date.now();
  const transferMs = Math.min(timeoutFor(options, 'downloadMs', DOWNLOAD_TIMEOUT_MS), Math.max(1, remaining));
  const deadline = operationSignal(signal, transferMs);
  const transferSignal = deadline.signal;
  try {
    let response;
    try {
      response = await raceWithSignal(fetchImpl(descriptor.url, {
        method: 'GET', redirect: 'error', signal: transferSignal, headers: { accept: 'application/octet-stream' },
      }), transferSignal);
    } catch {
      if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
      throw new RunnerError('blob_unavailable');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response);
      throw new RunnerError('blob_redirect_rejected');
    }
    if (!response.ok || !response.body) {
      cancelBody(response);
      throw new RunnerError('blob_unavailable');
    }
    if (response.headers.get('x-goog-generation') !== expected.generation) {
      cancelBody(response);
      throw new RunnerError('input_snapshot_mismatch');
    }
    let handle;
    let created = false;
    let completed = false;
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      handle = await open(destination, 'wx', 0o600);
      created = true;
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
        throw new RunnerError('input_write_failed');
      }
      await consumeBody(response, expected.bytes, transferSignal, async (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          // consumeBody は RunnerError 以外を response_unreadable にまとめるので、ディスク不足はここで固有の code にする
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset).catch((cause) => {
            throw isDiskFull(cause) ? new RunnerError('disk_limit') : cause;
          });
          if (bytesWritten <= 0) throw new RunnerError('input_write_failed');
          offset += bytesWritten;
        }
      });
      await handle.sync();
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new RunnerError('input_snapshot_mismatch');
      completed = true;
      return Object.freeze({ bytes, sha256: expected.sha256, generation: expected.generation });
    } catch (error) {
      if (error instanceof RunnerError && error.code === 'response_limit') {
        throw new RunnerError('input_snapshot_mismatch');
      }
      if (error instanceof RunnerError || (error && typeof error.code === 'string' && error.code === 'cancelled')) throw error;
      if (isDiskFull(error)) throw new RunnerError('disk_limit');
      if (signal?.aborted) throw signal.reason ?? new RunnerError('cancelled');
      if (transferSignal.aborted) throw new RunnerError('blob_unavailable');
      throw new RunnerError('input_write_failed');
    } finally {
      await handle?.close();
      if (!completed) cancelBody(response);
      if (created && !completed) await unlink(destination).catch(() => {});
    }
  } finally {
    deadline.clear();
  }
}

export async function uploadSignedCandidate(options) {
  const { reservation, bytes, fetchImpl = globalThis.fetch, signal } = options;
  validateGcsSignedUrl(reservation.url, { signedHeaders: CANDIDATE_SIGNED_HEADERS });
  expect(validDate(reservation.expiresAt), 'candidate_integrity_mismatch');
  expect(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 8 * 1024 ** 2
    && bytes.length === reservation.bytes, 'candidate_integrity_mismatch');
  const remaining = Date.parse(reservation.expiresAt) - Date.now();
  const transferMs = Math.min(timeoutFor(options, 'uploadMs', UPLOAD_TIMEOUT_MS), Math.max(1, remaining));
  const deadline = operationSignal(signal, transferMs);
  const transferSignal = deadline.signal;
  try {
    const response = await raceWithSignal(fetchImpl(reservation.url, {
      method: 'PUT', redirect: 'error', signal: transferSignal, headers: reservation.headers, body: bytes,
    }), transferSignal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response);
      throw new RunnerError('candidate_put_rejected', { fatal: true });
    }
    if (!response.ok) {
      cancelBody(response);
      throw new RunnerError('candidate_put_rejected', { fatal: true });
    }
    await boundedBody(response, MAX_ERROR_BYTES, transferSignal);
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'candidate_put_rejected') throw error;
    throw new RunnerError('candidate_put_outcome_unknown', { fatal: true, outcomeUnknown: true });
  } finally {
    deadline.clear();
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocsRunnerClient } from '../http-client.mjs';
import { processClaim, recoverClaim, runPollingService } from '../service.mjs';
import { TranscriptionError } from '../errors.mjs';

const secret = 's'.repeat(43);
const grant = 'g'.repeat(43);
const candidateId = '123e4567-e89b-42d3-a456-426614174000';
const expiresAt = '2099-01-01T00:00:00.000Z';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signed = (name, generation) => {
  const url = new URL(`https://storage.googleapis.com/niho-private/${name}`);
  for (const [key, value] of Object.entries({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256', 'X-Goog-Credential': 'credential',
    'X-Goog-Date': '20261017T000000Z', 'X-Goog-Expires': '600',
    'X-Goog-SignedHeaders': generation
      ? 'host' : 'content-type;host;x-goog-content-length-range;x-goog-if-generation-match',
    'X-Goog-Signature': 'abc123',
  })) url.searchParams.set(key, value);
  if (generation) {
    url.searchParams.set('generation', generation);
    url.searchParams.set('response-content-type', 'application/octet-stream');
  }
  return url.href;
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const apiCalls = (calls, suffix) => calls.filter((call) => {
  const url = new URL(call.raw);
  return url.hostname === 'niho.life' && url.pathname.endsWith(suffix);
});

async function harness(t, { mode = 'ok', heartbeatMs = 5, leaseExpiresAt = expiresAt, heartbeatExpiresAt = leaseExpiresAt, candidateUrlExpiresAt = leaseExpiresAt } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-service-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies = [Buffer.from('first private audio'), Buffer.from('second private audio')];
  const inputs = bodies.map((body, index) => ({
    ordinal: index, checkpointId: `checkpoint_${index + 1}`, sha256: hash(body), bytes: body.length, generation: String(100 + index),
  }));
  const claim = {
    status: 'LEASED', runId: 'run_1', attemptId: 'attempt_1', generation: 7,
    candidateId, grant, expiresAt: leaseExpiresAt, language: 'ja', speakerMode: 'auto', inputs,
  };
  const events = [];
  const calls = [];
  let heartbeatCount = 0;
  let uploaded;
  let submitting = false;
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw);
    calls.push({ raw, method: options.method, headers: options.headers });
    if (url.hostname === 'storage.googleapis.com') {
      assert.equal(options.headers?.authorization, undefined);
      assert.equal(options.headers?.['x-docs-grant'], undefined);
      if (options.method === 'PUT') {
        if (mode === 'put-unknown') throw new Error('response lost');
        uploaded = Buffer.from(options.body);
        return new Response('', { status: 200 });
      }
      const index = url.pathname.endsWith('input-1') ? 0 : 1;
      return new Response(bodies[index], { headers: { 'x-goog-generation': inputs[index].generation } });
    }
    assert.equal(url.origin, 'https://niho.life');
    assert.match(options.headers.authorization, /^DocsRunner /);
    if (url.pathname.endsWith('/heartbeat')) {
      heartbeatCount++;
      if (mode === 'heartbeat-hang') return new Promise(() => {});
      if (mode === 'submit-heartbeat-race' && submitting) return json({}, 403);
      if (mode === 'heartbeat-rejected') return json({}, 403);
      if (mode === 'heartbeat-unknown') throw new Error('network down');
      return json({ expiresAt: heartbeatExpiresAt });
    }
    if (url.pathname.includes('/inputs/')) {
      const input = inputs.find((entry) => url.pathname.endsWith(entry.checkpointId));
      return json({
        url: signed(`input-${inputs.indexOf(input) + 1}`, input.generation), expiresAt: leaseExpiresAt,
        sha256: input.sha256, bytes: input.bytes, generation: input.generation,
      });
    }
    if (url.pathname.endsWith('/candidate')) {
      if (mode === 'candidate-unknown') throw new Error('response lost');
      const requested = JSON.parse(options.body);
      return json({
        candidateId, url: signed('candidate'), headers: {
          'content-type': 'text/markdown', 'x-goog-if-generation-match': '0',
          'x-goog-content-length-range': `${requested.bytes},${requested.bytes}`,
        }, expiresAt: candidateUrlExpiresAt, candidateExpiresAt: '2099-01-08T00:00:00.000Z', bytes: requested.bytes, maxBytes: 8 * 1024 ** 2,
      });
    }
    if (url.pathname.endsWith('/dispatch')) return json({ status: 'SUBMITTED' });
    if (url.pathname.endsWith('/submit')) {
      if (mode === 'submit-unknown') throw new Error('response lost');
      if (mode === 'submit-heartbeat-race') {
        submitting = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return json({ runId: claim.runId, state: 'TRANSCRIPTION_COMPLETE', candidateId, generation: claim.generation });
    }
    if (url.pathname.endsWith('/fail')) {
      if (mode === 'fail-unknown') throw new Error('response lost');
      return json({ runId: claim.runId, state: 'FAILED' });
    }
    throw new Error('unexpected request');
  };
  const client = createDocsRunnerClient({ apiOrigin: 'https://niho.life', runnerId: 'shared_mac_1', languages: ['ja'], secret, fetchImpl });
  const config = { runnerId: 'shared_mac_1', sidecarPath: join(root, 'speech'), workRoot: root, languages: ['ja'], heartbeatMs };
  const transcribed = [];
  const transcribe = async ({ audio, signal, language, speakerMode }) => {
    transcribed.push({ language, speakerMode });
    const seen = await Promise.all(audio.map((entry) => readFile(entry.inputPath, 'utf8')));
    assert.deepEqual(seen, bodies.map((body) => body.toString()));
    if (mode.startsWith('heartbeat')) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(resolve, 200);
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const markdown = '[00:00:00] 一つ目。\n\n[00:01:00] 二つ目。\n';
    return { markdown, candidate: { bytes: Buffer.byteLength(markdown), sha256: hash(markdown) } };
  };
  return {
    root, claim, client, config, transcribe, transcribed, fetchImpl, events, calls,
    logger: (entry) => events.push(entry), heartbeatCount: () => heartbeatCount, uploaded: () => uploaded,
  };
}

test('two ordered inputs stream through transcription, bounded PUT, and submit while heartbeat continues', async (t) => {
  const h = await harness(t);
  const receipt = await processClaim(h);
  assert.equal(receipt.state, 'TRANSCRIPTION_COMPLETE');
  assert.match(h.uploaded().toString(), /一つ目/);
  assert.ok(h.heartbeatCount() >= 1);
  assert.equal(apiCalls(h.calls, '/candidate').length, 1);
  assert.equal(apiCalls(h.calls, '/submit').length, 1);
  assert.equal(apiCalls(h.calls, '/dispatch').length, 0);
  assert.deepEqual(await readdir(h.root), []);
  const diagnostics = JSON.stringify(h.events);
  for (const forbidden of [secret, grant, 'storage.googleapis.com', '一つ目', 'first private audio']) {
    assert.equal(diagnostics.includes(forbidden), false);
  }
});

for (const [name, submitted, receipt, expectedDispatch, expectedSubmit] of [
  ['candidate/upload ambiguity', false, null, 0, 1],
  ['dispatch ambiguity', true, null, 0, 1],
  ['submit ambiguity with receipt', true, { state: 'TRANSCRIPTION_COMPLETE' }, 0, 0],
]) {
  test(`restart reconciles ${name} without transcription`, async () => {
    const recovery = { status: 'RECOVERY', runId: 'run_1', attemptId: 'attempt_1', generation: 7, candidateId, grant, expiresAt, submitted };
    const calls = { outcome: 0, dispatch: 0, submit: 0 };
    const client = {
      outcome: async () => { calls.outcome++; return {
        runId: recovery.runId, attempt: { generation: 7, state: submitted ? 'SUBMITTED' : 'LEASED', submitted, finishedAt: null },
        candidate: { candidateId, state: 'RESERVED', expiresAt, sha256: null, bytes: 10 }, receipt,
      }; },
      dispatch: async () => { calls.dispatch++; return { status: 'SUBMITTED' }; },
      submit: async () => { calls.submit++; return { state: 'TRANSCRIPTION_COMPLETE' }; },
    };
    await recoverClaim({ claim: recovery, client, logger: () => {}, clock: () => Date.parse('2026-10-17T00:00:00Z') });
    assert.deepEqual(calls, { outcome: 1, dispatch: expectedDispatch, submit: expectedSubmit });
  });
}

test('a claim that cannot fit on the work disk is stopped before any 2 GiB download and pauses the runner', async (t) => {
  const h = await harness(t);
  // 置き場の空きを確実に超える大きさ（1 PiB）。実際の download は始めない。
  h.claim.inputs = [{ ...h.claim.inputs[0], bytes: 2 ** 50 }];
  await assert.rejects(processClaim(h), { code: 'disk_limit', fatal: true });
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
  assert.equal(h.calls.some((call) => new URL(call.raw).hostname === 'storage.googleapis.com'), false);
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
  assert.deepEqual(await readdir(h.root), []);
});

test('running out of disk while downloading an input fails the attempt once and pauses the runner', async (t) => {
  const { open: openFile } = await import('node:fs/promises');
  const h = await harness(t);
  const probe = await openFile(join(h.root, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(join(h.root, 'probe'));
  t.mock.method(handlePrototype, 'write', async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
  await assert.rejects(processClaim(h), { code: 'disk_limit', fatal: true });
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
  assert.equal(apiCalls(h.calls, '/submit').length, 0);
  assert.deepEqual(await readdir(h.root), []);
  assert.equal(JSON.stringify(h.events).includes('first private audio'), false);
});

test('server-bound language cannot be overridden by local runner configuration', async (t) => {
  const h = await harness(t);
  h.claim.language = 'en';
  await assert.rejects(processClaim(h), { code: 'claim_language_mismatch', fatal: true });
  assert.equal(h.calls.length, 0);
});

test('a runner configured for Japanese and English transcribes an English claim in English', async (t) => {
  const h = await harness(t);
  h.config = { ...h.config, languages: ['ja', 'en'] };
  h.claim.language = 'en';
  assert.equal((await processClaim(h)).state, 'TRANSCRIPTION_COMPLETE');
  assert.deepEqual(h.transcribed, [{ language:'en', speakerMode:'auto' }]);
});

test('a candidate URL that outlives the local lease is accepted once an authenticated heartbeat extends it', async (t) => {
  // 並行する heartbeat が API で延長を commit したが、その応答がまだ手元に届いていない間に candidate が届いた形
  const h = await harness(t, {
    heartbeatMs: 10_000,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    candidateUrlExpiresAt: '2099-01-01T00:10:00.000Z',
    heartbeatExpiresAt: '2099-01-01T00:20:00.000Z',
  });
  await processClaim(h);
  assert.equal(apiCalls(h.calls, '/candidate').length, 1);
  assert.equal(apiCalls(h.calls, '/submit').length, 1);
  // 期限を取り直す heartbeat と、submit の前の最後の heartbeat
  assert.equal(h.heartbeatCount(), 2);
});

test('a candidate URL that outlives even the authenticated lease is still rejected before any upload', async (t) => {
  const h = await harness(t, {
    heartbeatMs: 10_000,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    candidateUrlExpiresAt: '2099-01-01T00:10:00.000Z',
    heartbeatExpiresAt: '2099-01-01T00:00:00.000Z',
  });
  await assert.rejects(processClaim(h), { code: 'candidate_expired' });
  assert.equal(h.uploaded(), undefined);
  assert.equal(apiCalls(h.calls, '/submit').length, 0);
});

test('final heartbeat stops the loop before submit, so a late 403 cannot overwrite a receipt', async (t) => {
  const h = await harness(t, { mode: 'submit-heartbeat-race', heartbeatMs: 5 });
  const receipt = await processClaim(h);
  assert.equal(receipt.state, 'TRANSCRIPTION_COMPLETE');
  assert.equal(apiCalls(h.calls, '/submit').length, 1);
  const submitIndex = h.calls.findIndex((call) => call.raw.endsWith('/submit'));
  assert.equal(h.calls.slice(submitIndex + 1).some((call) => call.raw.endsWith('/heartbeat')), false);
});

test('lease expiry aborts processing even while the heartbeat request itself never settles', async (t) => {
  const h = await harness(t, {
    mode: 'heartbeat-hang', heartbeatMs: 5, leaseExpiresAt: new Date(Date.now() + 80).toISOString(),
  });
  await assert.rejects(processClaim(h), { code: 'attempt_expired', fatal: true });
  assert.ok(h.heartbeatCount() >= 1);
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
  assert.equal(apiCalls(h.calls, '/submit').length, 0);
  assert.deepEqual(await readdir(h.root), []);
});

for (const mode of ['heartbeat-rejected', 'heartbeat-unknown']) {
  test(`${mode} aborts recognition and prevents candidate/submit`, async (t) => {
    const h = await harness(t, { mode });
    const expected = mode === 'heartbeat-rejected' ? 'credential_rejected' : 'heartbeat_unknown';
    await assert.rejects(processClaim(h), { code: expected });
    assert.equal(apiCalls(h.calls, '/candidate').length, 0);
    assert.equal(apiCalls(h.calls, '/submit').length, 0);
    assert.equal(apiCalls(h.calls, '/fail').length, 0);
    assert.deepEqual(await readdir(h.root), []);
  });
}

for (const mode of ['candidate-unknown', 'put-unknown', 'submit-unknown']) {
  test(`${mode} is fatal and never creates another candidate or retries finalization`, async (t) => {
    const h = await harness(t, { mode, heartbeatMs: 10_000 });
    const expected = mode === 'candidate-unknown' ? 'candidate_outcome_unknown'
      : mode === 'put-unknown' ? 'candidate_put_outcome_unknown' : 'submit_outcome_unknown';
    await assert.rejects(processClaim(h), { code: expected, fatal: true, outcomeUnknown: true });
    assert.equal(apiCalls(h.calls, '/candidate').length, 1);
    assert.equal(apiCalls(h.calls, '/submit').length, mode === 'submit-unknown' ? 1 : 0);
    assert.equal(apiCalls(h.calls, '/fail').length, 0);
    assert.deepEqual(await readdir(h.root), []);
  });
}

test('SIGTERM-style cancellation aborts work, deletes staging, and does not submit or fail', async (t) => {
  const h = await harness(t, { mode: 'heartbeat-waits', heartbeatMs: 10_000 });
  h.transcribe = async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const pending = processClaim({ ...h, signal: controller.signal });
  while (!h.calls.some((call) => call.raw.includes('/inputs/'))) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
  assert.equal(apiCalls(h.calls, '/fail').length, 0);
  assert.deepEqual(await readdir(h.root), []);
});

test('local candidate integrity failure reports fail once and never reserves output', async (t) => {
  const h = await harness(t, { heartbeatMs: 10_000 });
  h.transcribe = async () => ({ markdown: 'private text', candidate: { bytes: 1, sha256: '0'.repeat(64) } });
  await assert.rejects(processClaim(h), { code: 'candidate_integrity_mismatch' });
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
});

test('resource exhaustion reports fail once and pauses the service class of error', async (t) => {
  const h = await harness(t, { heartbeatMs: 10_000 });
  h.transcribe = async () => { throw new TranscriptionError('resource_unavailable'); };
  await assert.rejects(processClaim(h), { code: 'resource_unavailable', fatal: true });
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
});

test('unknown fail outcome stops instead of polling another job', async (t) => {
  const h = await harness(t, { mode: 'fail-unknown', heartbeatMs: 10_000 });
  h.transcribe = async () => ({ markdown: 'private text', candidate: { bytes: 1, sha256: '0'.repeat(64) } });
  await assert.rejects(processClaim(h), { code: 'fail_outcome_unknown', fatal: true, outcomeUnknown: true });
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
  assert.equal(apiCalls(h.calls, '/candidate').length, 0);
});

test('a staging cleanup failure stops the service even after a non-fatal attempt failure', { skip: process.getuid?.() === 0 }, async (t) => {
  // 音声を含む作業場所を残したまま次の claim へ進まない
  const h = await harness(t, { heartbeatMs: 10_000 });
  h.transcribe = async () => {
    await chmod(h.root, 0o500);
    throw new TranscriptionError('silent_audio');
  };
  try {
    await assert.rejects(processClaim(h), { code: 'workspace_cleanup_failed', fatal: true });
  } finally {
    await chmod(h.root, 0o700);
  }
  assert.equal(apiCalls(h.calls, '/fail').length, 1);
  assert.ok(h.events.some((event) => event.event === 'workspace_cleanup_failed' && event.code === 'silent_audio'));
});

test('polling skips explicit terminal claim states and backs off on waiting capacity', async () => {
  const controller = new AbortController();
  const statuses = ['RESULT_UNKNOWN', 'FAILED', 'INPUT_CHANGED', 'INPUT_EXPIRED', 'WAITING_CAPACITY'];
  const seen = [];
  const client = { claim: async () => ({ status: statuses.shift() }) };
  const config = { runnerId: 'runner', idlePollMs: 250, maxIdlePollMs: 1000 };
  const pending = runPollingService({
    client, config, signal: controller.signal,
    logger: (entry) => seen.push(entry),
    delay: async (ms) => {
      assert.equal(ms, 250);
      controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      throw controller.signal.reason;
    },
  });
  await assert.rejects(pending, { code: 'cancelled' });
  assert.deepEqual(seen.filter((entry) => entry.event === 'poll_terminal').map((entry) => entry.code), [
    'result_unknown', 'failed', 'input_changed', 'input_expired',
  ]);
});

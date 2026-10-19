import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDocsRunnerClient, downloadSignedInput, uploadSignedCandidate, validateGcsSignedUrl,
  TEST_ONLY_TIMEOUTS,
} from '../http-client.mjs';

const secret = 's'.repeat(43);
const grant = 'g'.repeat(43);
const candidateId = '123e4567-e89b-42d3-a456-426614174000';
const signed = (name, generation) => {
  const url = new URL(`https://storage.googleapis.com/private-bucket/${name}`);
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
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers },
});

test('signed blob URL accepts only direct HTTPS GCS signatures without userinfo/hash', () => {
  assert.equal(validateGcsSignedUrl(signed('input', '123'), { generation: '123' }).hostname, 'storage.googleapis.com');
  for (const raw of [
    signed('input', '124'),
    signed('input', '123').replace('https://', 'http://'),
    signed('input', '123').replace('storage.googleapis.com', 'evil.example'),
    signed('input', '123') + '#secret',
    signed('input', '123').replace('https://', 'https://user@'),
    `${signed('input', '123')}&unknown=value`,
    'https://storage.googleapis.com/private/input?generation=123',
  ]) assert.throws(() => validateGcsSignedUrl(raw, { generation: '123' }));
});

test('API client refuses redirects, 401/403, response overflow, and candidate header injection', async () => {
  for (const status of [401, 403]) {
    const client = createDocsRunnerClient({ apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async () => json({}, { status }) });
    await assert.rejects(client.claim(), { code: 'credential_rejected', fatal: true });
  }
  for (const languages of [undefined, [], ['fr'], ['ja', 'ja'], 'ja']) {
    assert.throws(() => createDocsRunnerClient({ apiOrigin: 'https://niho.life', runnerId: 'runner', languages, secret, fetchImpl: async () => json({}) }), { code: 'invalid_configuration' });
  }
  const redirected = createDocsRunnerClient({
    apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://attacker.example' } }),
  });
  await assert.rejects(redirected.claim(), { code: 'api_redirect_rejected' });
  const overflow = createDocsRunnerClient({
    apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret,
    fetchImpl: async () => new Response('x'.repeat(70 * 1024)),
  });
  await assert.rejects(overflow.claim(), { code: 'claim_outcome_unknown', outcomeUnknown: true });
  const claim = { runId: 'run', candidateId, generation: 1, grant };
  const injected = createDocsRunnerClient({
    apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret,
    fetchImpl: async () => json({
      candidateId, url: signed('candidate'), expiresAt: '2099-01-01T00:00:00.000Z', candidateExpiresAt: '2099-01-08T00:00:00.000Z', bytes: 3, maxBytes: 100,
      headers: {
        'content-type': 'text/markdown', 'x-goog-if-generation-match': '0',
        'x-goog-content-length-range': '3,3', authorization: 'secret',
      },
    }),
  });
  await assert.rejects(injected.candidate(claim, 3), {
    code: 'candidate_outcome_unknown', fatal: true, outcomeUnknown: true,
  });
});

test('claim parser preserves server input order and rejects snapshot drift', async () => {
  const inputs = [
    { ordinal: 0, checkpointId: 'second', sha256: '2'.repeat(64), bytes: 22, generation: '102' },
    { ordinal: 1, checkpointId: 'first', sha256: '1'.repeat(64), bytes: 11, generation: '101' },
  ];
  const response = {
    status: 'LEASED', runId: 'run', attemptId: 'attempt', generation: 3,
    candidateId, grant, expiresAt: '2099-01-01T00:00:00.000Z', language: 'ja', speakerMode: 'auto', inputs,
  };
  const client = createDocsRunnerClient({
    apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `DocsRunner runner:${secret}`);
      return json(response);
    },
  });
  assert.deepEqual((await client.claim()).inputs.map((entry) => entry.checkpointId), ['second', 'first']);
  response.inputs = [{ ...inputs[0], ordinal: 0, bytes: 2 * 1024 ** 3 }];
  assert.equal((await client.claim()).inputs[0].bytes, 2 * 1024 ** 3);
  response.inputs = [{ ...inputs[0], ordinal: 0, bytes: 2 * 1024 ** 3 + 1 }];
  await assert.rejects(client.claim(), { code: 'claim_outcome_unknown', outcomeUnknown: true });
  response.inputs = [{ ...inputs[0], bytes: 0 }];
  await assert.rejects(client.claim(), { code: 'claim_outcome_unknown', outcomeUnknown: true });
  response.inputs = inputs;
  delete response.speakerMode;
  await assert.rejects(client.claim(), { code: 'claim_outcome_unknown', outcomeUnknown: true });
  response.speakerMode = 'unknown';
  await assert.rejects(client.claim(), { code: 'claim_outcome_unknown', outcomeUnknown: true });
});

test('download streams to 0600 and verifies generation, byte count, and SHA-256', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-http-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('private audio bytes');
  const expected = { generation: '123', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const descriptor = { url: signed('input', '123'), expiresAt: '2099-01-01T00:00:00.000Z' };
  const destination = join(root, 'input');
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['x-docs-grant'], undefined);
    assert.equal(options.redirect, 'error');
    return new Response(body, { headers: { 'x-goog-generation': '123' } });
  };
  assert.deepEqual(await downloadSignedInput({ descriptor, expected, destination, fetchImpl }), expected);
  assert.deepEqual(await readFile(destination), body);
  for (const bad of [
    { ...expected, bytes: body.length - 1 },
    { ...expected, sha256: '0'.repeat(64) },
    { ...expected, generation: '124' },
  ]) {
    await assert.rejects(downloadSignedInput({ descriptor, expected: bad, destination: join(root, `bad-${bad.bytes}-${bad.generation}`), fetchImpl }), {
      code: 'input_snapshot_mismatch',
    });
  }
  const redirectFetch = async () => new Response('', { status: 307, headers: { location: signed('other', '123') } });
  await assert.rejects(downloadSignedInput({ descriptor, expected, destination: join(root, 'redirect'), fetchImpl: redirectFetch }), { code: 'blob_redirect_rejected' });

  let boundaryFetches = 0;
  const boundaryFetch = async () => { boundaryFetches += 1; return new Response(null, { status: 404 }); };
  await assert.rejects(downloadSignedInput({
    descriptor,
    expected: { ...expected, bytes: 2 * 1024 ** 3 },
    destination: join(root, 'exact-2gib'),
    fetchImpl: boundaryFetch,
  }), { code: 'blob_unavailable' });
  assert.equal(boundaryFetches, 1);
  await assert.rejects(downloadSignedInput({
    descriptor,
    expected: { ...expected, bytes: 2 * 1024 ** 3 + 1 },
    destination: join(root, 'over-2gib'),
    fetchImpl: boundaryFetch,
  }), { code: 'input_snapshot_mismatch' });
  assert.equal(boundaryFetches, 1);
});

test('download that runs out of disk reports disk_limit (a pause code) and leaves no partial file', async (t) => {
  const { open: openFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-http-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('private audio bytes');
  const expected = { generation: '123', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const descriptor = { url: signed('input', '123'), expiresAt: '2099-01-01T00:00:00.000Z' };
  const fetchImpl = async () => new Response(body, { headers: { 'x-goog-generation': '123' } });
  const probe = await openFile(join(root, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  for (const errno of ['ENOSPC', 'EDQUOT']) {
    const write = t.mock.method(handlePrototype, 'write', async () => { throw Object.assign(new Error('no space'), { code: errno }); });
    const destination = join(root, `full-${errno}`);
    await assert.rejects(downloadSignedInput({ descriptor, expected, destination, fetchImpl }), { code: 'disk_limit', message: 'disk_limit' });
    assert.equal(write.mock.callCount(), 1);
    write.mock.restore();
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  }
  // 別の書き込み失敗はこれまでどおり disk_limit にしない。
  t.mock.method(handlePrototype, 'write', async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
  await assert.rejects(downloadSignedInput({ descriptor, expected, destination: join(root, 'io'), fetchImpl }), { code: 'response_unreadable' });
});

test('candidate PUT sends only allowlisted signed headers and treats response loss as unknown', async () => {
  const bytes = Buffer.from('abc');
  const reservation = {
    url: signed('candidate'), bytes: 3, expiresAt: '2099-01-01T00:00:00.000Z',
    headers: {
      'content-type': 'text/markdown', 'x-goog-if-generation-match': '0', 'x-goog-content-length-range': '3,3',
    },
  };
  await uploadSignedCandidate({ reservation, bytes, fetchImpl: async (_url, options) => {
    assert.deepEqual(options.headers, reservation.headers);
    assert.equal(options.headers.authorization, undefined);
    assert.deepEqual(options.body, bytes);
    return new Response('', { status: 200 });
  } });
  await assert.rejects(uploadSignedCandidate({ reservation, bytes, fetchImpl: async () => { throw new Error('secret url'); } }), {
    code: 'candidate_put_outcome_unknown', outcomeUnknown: true,
  });
});

test('API operations send exact authorization, grant, method, and JSON bodies', async () => {
  const calls = [];
  const claim = { runId: 'run', attemptId: 'attempt', candidateId, generation: 2, grant };
  const expected = { checkpointId: 'checkpoint', sha256: '1'.repeat(64), bytes: 4, generation: '123' };
  const fetchImpl = async (raw, options) => {
    const path = new URL(raw).pathname;
    calls.push({ path, ...options });
    if (path.endsWith('/claim')) return json({ status: 'IDLE' });
    if (path.includes('/inputs/')) return json({
      url: signed('input', '123'), expiresAt: '2099-01-01T00:00:00.000Z',
      sha256: expected.sha256, bytes: expected.bytes, generation: expected.generation,
    });
    if (path.endsWith('/heartbeat')) return json({ expiresAt: '2099-01-01T00:00:00.000Z' });
    if (path.endsWith('/candidate')) return json({
      candidateId, url: signed('candidate'), expiresAt: '2099-01-01T00:00:00.000Z', candidateExpiresAt: '2099-01-08T00:00:00.000Z', bytes: 4, maxBytes: 4,
      headers: {
        'content-type': 'text/markdown', 'x-goog-if-generation-match': '0',
        'x-goog-content-length-range': '4,4',
      },
    });
    if (path.endsWith('/dispatch')) return json({ status: 'SUBMITTED' });
    if (path.endsWith('/submit')) return json({ runId: 'run', state: 'SUCCEEDED', candidateId, generation: 2 });
    if (path.endsWith('/fail')) return json({ runId: 'run', state: 'FAILED' });
    throw new Error('unexpected');
  };
  const client = createDocsRunnerClient({ apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl });
  await client.claim();
  await client.input(claim, expected);
  await client.heartbeat(claim);
  await client.candidate(claim, 4);
  await client.dispatch(claim);
  await client.submit(claim);
  await client.fail(claim);
  assert.deepEqual(calls.map(({ path, method, body }) => [path.split('/').at(-1), method, body]), [
    ['claim', 'POST', '{"languages":["ja"]}'], ['checkpoint', 'GET', undefined], ['heartbeat', 'POST', '{}'],
    ['candidate', 'POST', '{"bytes":4}'], ['dispatch', 'POST', '{}'], ['submit', 'POST', `{"candidateId":"${candidateId}"}`],
    ['fail', 'POST', '{}'],
  ]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.redirect, 'error');
    assert.equal(call.headers.authorization, `DocsRunner runner:${secret}`);
    assert.equal(call.headers['x-docs-grant'], index === 0 ? undefined : grant);
    assert.equal(call.headers['content-type'], index === 1 ? undefined : 'application/json');
  }
});

test('claim accepts only the explicit passive states and allowlisted 409 wait reasons', async () => {
  for (const status of ['IDLE', 'RESULT_UNKNOWN', 'FAILED', 'INPUT_CHANGED', 'INPUT_EXPIRED', 'WAITING_CAPACITY']) {
    const client = createDocsRunnerClient({
      apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async () => json({ status }),
    });
    assert.deepEqual(await client.claim(), { status });
  }
  for (const reason of ['attempt_held', 'vault_lease_held']) {
    const client = createDocsRunnerClient({
      apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret,
      fetchImpl: async () => json({ error: { details: { reason } } }, { status: 409 }),
    });
    assert.deepEqual(await client.claim(), { status: 'WAITING_CAPACITY' });
  }
  for (const body of [json({ status: 'NEW_STATE' }), json({ error: { details: { reason: 'unknown' } } }, { status: 409 })]) {
    const client = createDocsRunnerClient({
      apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async () => body.clone(),
    });
    await assert.rejects(client.claim(), { fatal: true });
  }
});

test('successful malformed mutation responses are fatal outcome-unknown results', async () => {
  const claim = { runId: 'run', attemptId: 'attempt', candidateId, generation: 2, grant };
  const cases = [
    ['claim', (client) => client.claim(), new Response('{')],
    ['candidate', (client) => client.candidate(claim, 4), json({ candidateId: 'wrong' })],
    ['submit', (client) => client.submit(claim), new Response('x'.repeat(70 * 1024))],
    ['fail', (client) => client.fail(claim), json({ runId: 'other', state: 'FAILED' })],
  ];
  for (const [operation, invoke, response] of cases) {
    const client = createDocsRunnerClient({
      apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async () => response.clone(),
    });
    await assert.rejects(invoke(client), {
      code: `${operation}_outcome_unknown`, fatal: true, outcomeUnknown: true,
    });
  }
});

test('claim transport failures stay retryable, but a broken 2xx claim still stops', async () => {
  // 応答が届かなくても、再 claim は自分の lease を 409 attempt_held（待機）で返すので、polling の backoff で再試行してよい
  const client = createDocsRunnerClient({
    apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl: async () => { throw new TypeError('network reset'); },
  });
  const error = await client.claim().then(() => null, (caught) => caught);
  assert.equal(error.code, 'network_unavailable');
  assert.notEqual(error.fatal, true);
  assert.notEqual(error.outcomeUnknown, true);
});

test('submit receipts accept only the run states the API can return', async () => {
  const claim = { runId: 'run', attemptId: 'attempt', candidateId, generation: 2, grant };
  for (const [state, accepted] of [['SUCCEEDED', true], ['TRANSCRIPTION_COMPLETE', true], ['INPUT_CHANGED', true],
    ['QUEUED', true], ['WAITING_PC', true], ['WAITING_STORAGE', true], ['RUNNING', false], ['DONE', false]]) {
    const client = createDocsRunnerClient({
      apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret,
      fetchImpl: async () => json({ runId: 'run', state, candidateId, generation: 2 }),
    });
    if (accepted) assert.equal((await client.submit(claim)).state, state);
    else await assert.rejects(client.submit(claim), { code: 'submit_outcome_unknown', fatal: true, outcomeUnknown: true });
  }
});

test('every API fetch and response body has a short abortable deadline', async () => {
  const claim = { runId: 'run', attemptId: 'attempt', candidateId, generation: 2, grant };
  const input = { checkpointId: 'checkpoint', sha256: '1'.repeat(64), bytes: 4, generation: '123' };
  const operations = [
    ['network_unavailable', (client) => client.claim()],
    ['network_unavailable', (client) => client.input(claim, input)],
    ['heartbeat_unknown', (client) => client.heartbeat(claim)],
    ['candidate_outcome_unknown', (client) => client.candidate(claim, 4)],
    ['submit_outcome_unknown', (client) => client.submit(claim)],
    ['fail_outcome_unknown', (client) => client.fail(claim)],
  ];
  for (const bodyHang of [false, true]) {
    for (const [code, invoke] of operations) {
      let cancelled = false;
      const fetchImpl = bodyHang
        ? async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))
        : async () => new Promise(() => {});
      const client = createDocsRunnerClient({
        apiOrigin: 'https://niho.life', runnerId: 'runner', languages: ['ja'], secret, fetchImpl,
        [TEST_ONLY_TIMEOUTS]: { apiMs: 10 },
      });
      await assert.rejects(invoke(client), { code });
      if (bodyHang) assert.equal(cancelled, true);
    }
  }
});

test('download cancels mismatched or failed streams, removes only its partial, and bounds an endless body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-stream-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('abcd');
  const expected = { generation: '123', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const descriptor = { url: signed('input', '123'), expiresAt: '2099-01-01T00:00:00.000Z' };
  let cancelled = false;
  const cancellable = () => new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  await assert.rejects(downloadSignedInput({
    descriptor, expected, destination: join(root, 'generation'),
    fetchImpl: async () => new Response(cancellable(), { headers: { 'x-goog-generation': '124' } }),
  }), { code: 'input_snapshot_mismatch' });
  assert.equal(cancelled, true);

  const partial = join(root, 'partial');
  await assert.rejects(downloadSignedInput({
    descriptor, expected, destination: partial,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.error(new Error('stream failed')); },
    }), { headers: { 'x-goog-generation': '123' } }),
  }), { code: 'response_unreadable' });
  await assert.rejects(stat(partial), { code: 'ENOENT' });

  const existing = join(root, 'existing');
  await writeFile(existing, 'keep', { mode: 0o600 });
  await assert.rejects(downloadSignedInput({
    descriptor, expected, destination: existing,
    fetchImpl: async () => new Response(bytes, { headers: { 'x-goog-generation': '123' } }),
  }), { code: 'input_write_failed' });
  assert.equal(await readFile(existing, 'utf8'), 'keep');

  const endless = join(root, 'endless');
  cancelled = false;
  await assert.rejects(downloadSignedInput({
    descriptor, expected, destination: endless,
    fetchImpl: async () => new Response(cancellable(), { headers: { 'x-goog-generation': '123' } }),
    [TEST_ONLY_TIMEOUTS]: { downloadMs: 10 },
  }));
  assert.equal(cancelled, true);
  await assert.rejects(stat(endless), { code: 'ENOENT' });
});

test('successful candidate PUT with an endless response body becomes outcome unknown', async () => {
  let cancelled = false;
  const reservation = {
    url: signed('candidate'), bytes: 3, expiresAt: '2099-01-01T00:00:00.000Z',
    headers: {
      'content-type': 'text/markdown', 'x-goog-if-generation-match': '0', 'x-goog-content-length-range': '3,3',
    },
  };
  await assert.rejects(uploadSignedCandidate({
    reservation, bytes: Buffer.from('abc'),
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    [TEST_ONLY_TIMEOUTS]: { uploadMs: 10 },
  }), { code: 'candidate_put_outcome_unknown', outcomeUnknown: true });
  assert.equal(cancelled, true);
});

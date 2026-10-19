import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupStaleAttempts } from '../cleanup.mjs';
import { API_ORIGINS, loadRunnerConfig, parseCliArguments } from '../config.mjs';
import { acquireRunnerLock } from '../lock.mjs';
import { RunnerError } from '../runner-errors.mjs';
import { runConfiguredService } from '../service.mjs';

const lockProcessPath = fileURLToPath(new URL('./lock-process.mjs', import.meta.url));

function waitForLine(stream, line) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('process timeout')), 2_000);
    stream.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes(`${line}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function retryLock(workRoot) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await acquireRunnerLock(workRoot); }
    catch (error) {
      if (error.code !== 'runner_already_running' || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-config-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const workRoot = join(root, 'work');
  await mkdir(workRoot, { mode: 0o700 });
  const configPath = join(root, 'config.json');
  const credentialPath = join(root, 'credential');
  const raw = {
    environment: 'prod', runnerId: 'shared_mac_1', sidecarPath: join(root, 'niho-speech'),
    workRoot, languages: ['ja'], idlePollMs: 250, heartbeatMs: 1000, maxIdlePollMs: 5000,
  };
  const save = async (value = raw) => writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
  await save();
  await writeFile(credentialPath, JSON.stringify({ runnerId: raw.runnerId, secret: 'a'.repeat(43) }) + '\n', { mode: 0o600 });
  return { root, workRoot, configPath, credentialPath, raw, save };
}

test('private config derives an exact environment origin and accepts only Japanese and English', async (t) => {
  const f = await fixture(t);
  const config = await loadRunnerConfig(f);
  assert.equal(config.apiOrigin, API_ORIGINS.prod);
  assert.deepEqual(config.languages, ['ja']);
  assert.equal(config.secret, 'a'.repeat(43));
  assert.deepEqual(parseCliArguments(['--config', f.configPath, '--credential', f.credentialPath]), {
    configPath: f.configPath, credentialPath: f.credentialPath,
  });
  await f.save({ ...f.raw, environment: 'stg' });
  assert.equal((await loadRunnerConfig(f)).apiOrigin, API_ORIGINS.stg);
  await f.save({ ...f.raw, languages: ['en', 'ja'] });
  assert.deepEqual((await loadRunnerConfig(f)).languages, ['ja', 'en']);
  for (const change of [
    { language: 'ja' },
    { environment: 'dev' },
    { apiOrigin: 'https://attacker.example' },
    // 空きのときも 60 秒以内ごとに claim しないと、API が「止まっている」と判定する（DOCS_RUNNER_STALE_MS）。
    { maxIdlePollMs: 60_001 },
  ]) {
    await f.save({ ...f.raw, ...change });
    await assert.rejects(loadRunnerConfig(f), { code: 'invalid_configuration' });
  }
  for (const languages of [undefined, [], ['ja', 'ja'], ['fr'], 'ja', ['ja', 'en', 'ja']]) {
    await f.save({ ...f.raw, languages });
    await assert.rejects(loadRunnerConfig(f), { code: 'invalid_configuration' });
  }
});

test('config, credential, parent, and work root must remain private regular paths', async (t) => {
  const f = await fixture(t);
  await chmod(f.credentialPath, 0o644);
  await assert.rejects(loadRunnerConfig(f), { code: 'private_configuration_invalid' });
  await chmod(f.credentialPath, 0o600);
  await writeFile(f.credentialPath, `${'a'.repeat(43)}\n`, { mode: 0o600 });
  await assert.rejects(loadRunnerConfig(f), { code: 'invalid_credential' });
  await writeFile(f.credentialPath, JSON.stringify({ runnerId: f.raw.runnerId, secret: 'a'.repeat(43) }), { mode: 0o600 });
  await chmod(f.workRoot, 0o755);
  await assert.rejects(loadRunnerConfig(f), { code: 'private_configuration_invalid' });
  await chmod(f.workRoot, 0o700);
  const link = join(f.root, 'credential-link');
  await symlink(f.credentialPath, link);
  await assert.rejects(loadRunnerConfig({ configPath: f.configPath, credentialPath: link }), { code: 'private_configuration_invalid' });
});

test('R2 credential JSON is bound to its configured runner and rejects other formats', async (t) => {
  const f = await fixture(t);
  for (const value of [
    { runnerId: 'another_runner', secret: 'a'.repeat(43) },
    { runnerId: f.raw.runnerId, secret: 'a'.repeat(42) },
    { runnerId: f.raw.runnerId, secret: 'a'.repeat(43), unexpected: true },
    'a'.repeat(43),
  ]) {
    await writeFile(f.credentialPath, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(loadRunnerConfig(f), { code: 'invalid_credential' });
  }
});

test('OS lock excludes a second instance and permits cleanup only after lock proof', async (t) => {
  const f = await fixture(t);
  const oldAttempt = join(f.workRoot, 'attempt-Ab12Cd');
  await mkdir(oldAttempt, { mode: 0o700 });
  await writeFile(join(oldAttempt, 'input'), 'private', { mode: 0o600 });
  const unrelated = join(f.workRoot, 'other-service');
  await mkdir(unrelated, { mode: 0o700 });
  const lock = await acquireRunnerLock(f.workRoot);
  await assert.rejects(acquireRunnerLock(f.workRoot), { code: 'runner_already_running' });
  const cleaned = await cleanupStaleAttempts({ workRoot: f.workRoot, singleInstanceConfirmed: true });
  assert.equal(cleaned.removedAttempts, 1);
  assert.ok((await readdir(f.workRoot)).includes('other-service'));
  await lock.release();
  const next = await acquireRunnerLock(f.workRoot);
  await next.release();
});

test('persistent private lock file is reusable, while an unsafe lock path is preserved and rejected', async (t) => {
  const f = await fixture(t);
  const lockPath = join(f.workRoot, '.docs-remote-runner.lock');
  const lock = await acquireRunnerLock(f.workRoot);
  await lock.release();
  assert.ok((await readdir(f.workRoot)).includes('.docs-remote-runner.lock'));
  const next = await acquireRunnerLock(f.workRoot);
  await next.release();
  await rm(lockPath);
  await mkdir(lockPath, { mode: 0o700 });
  await assert.rejects(acquireRunnerLock(f.workRoot), { code: 'runner_lock_invalid' });
  assert.ok((await readdir(f.workRoot)).includes('.docs-remote-runner.lock'));
});

test('real process contention keeps the same inode and SIGKILL releases the kernel lock', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [lockProcessPath, f.workRoot], {
    stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitForLine(child.stdout, 'ready');
  const lockPath = join(f.workRoot, '.docs-remote-runner.lock');
  const before = await lstat(lockPath);
  await assert.rejects(acquireRunnerLock(f.workRoot), { code: 'runner_already_running' });
  child.kill('SIGKILL');
  await waitForExit(child);
  const next = await retryLock(f.workRoot);
  const after = await lstat(lockPath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  await next.release();
});

test('lock helper death aborts service work and does not leave an orphan lock holder', async (t) => {
  const f = await fixture(t);
  const config = await loadRunnerConfig(f);
  const lock = await acquireRunnerLock(f.workRoot);
  let polling = false;
  const pending = runConfiguredService({
    config, lock,
    preflight: async () => ({ available: true, needsDownload: false, language: 'ja' }),
    fetchImpl: async () => new Response(JSON.stringify({ status: 'IDLE' }), {
      headers: { 'content-type': 'application/json' },
    }),
    delay: async (_ms, signal) => {
      polling = true;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  while (!polling) await new Promise((resolve) => setTimeout(resolve, 1));
  process.kill(lock.holderPid, 'SIGKILL');
  await assert.rejects(pending, { code: 'runner_lock_lost', fatal: true });
  await assert.rejects(lock.release(), { code: 'runner_lock_release_failed' });
  const next = await retryLock(f.workRoot);
  await next.release();
});

test('private config flows unchanged through client creation and polling', async (t) => {
  const f = await fixture(t);
  const config = await loadRunnerConfig(f);
  const lock = await acquireRunnerLock(f.workRoot);
  const controller = new AbortController();
  let claims = 0;
  try {
    await assert.rejects(runConfiguredService({
      config, lock, signal: controller.signal,
      preflight: async ({ language }) => ({ available: true, needsDownload: false, language }),
      fetchImpl: async (raw, options) => {
        claims++;
        assert.equal(raw, 'https://niho.life/api/internal/docs-runner/claim');
        assert.match(options.headers.authorization, /^DocsRunner shared_mac_1:/);
        assert.deepEqual(JSON.parse(options.body), { languages: ['ja'] });
        return new Response(JSON.stringify({ status: 'IDLE' }), { headers: { 'content-type': 'application/json' } });
      },
      delay: async () => {
        controller.abort(new RunnerError('cancelled'));
        throw controller.signal.reason;
      },
    }), { code: 'cancelled' });
    assert.equal(claims, 1);
  } finally {
    await lock.release();
  }
});

test('every configured language must have its model before the first claim', async (t) => {
  const f = await fixture(t);
  await f.save({ ...f.raw, languages: ['ja', 'en'] });
  const config = await loadRunnerConfig(f);
  for (const [missing, expected] of [['en', 'preflight_failed'], [null, 'cancelled']]) {
    const lock = await acquireRunnerLock(f.workRoot);
    const controller = new AbortController();
    const probed = [];
    let body;
    try {
      await assert.rejects(runConfiguredService({
        config, lock, signal: controller.signal,
        preflight: async ({ language }) => { probed.push(language); return { available: true, needsDownload: language === missing, language }; },
        fetchImpl: async (_raw, options) => {
          body = JSON.parse(options.body);
          return new Response(JSON.stringify({ status: 'IDLE' }), { headers: { 'content-type': 'application/json' } });
        },
        delay: async () => {
          controller.abort(new RunnerError('cancelled'));
          throw controller.signal.reason;
        },
      }), { code: expected });
    } finally {
      await lock.release();
    }
    assert.deepEqual(probed, ['ja', 'en']);
    assert.deepEqual(body, missing ? undefined : { languages: ['ja', 'en'] });
  }
});

test('CLI startup failure releases its lock instead of retaining it', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)),
    '--config', f.configPath, '--credential', f.credentialPath], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  await waitForExit(child);
  assert.equal(child.exitCode, 1);
  const next = await retryLock(f.workRoot);
  await next.release();
});

import { spawn } from 'node:child_process';
import { lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensurePrivateAcl } from './acl.mjs';
import { RunnerError } from './runner-errors.mjs';

const LOCK_NAME = '.docs-remote-runner.lock';
const holderPath = fileURLToPath(new URL('./lock-holder.mjs', import.meta.url));

function lockCommand(path) {
  if (process.platform === 'darwin') {
    return ['/usr/bin/lockf', ['-k', '-t', '0', path, process.execPath, holderPath]];
  }
  if (process.platform === 'linux') {
    return ['/usr/bin/flock', ['-E', '75', '-n', '-F', path, process.execPath, holderPath]];
  }
  throw new RunnerError('unsupported_platform', { fatal: true });
}

async function existingLock(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & 0o777) !== 0o600) throw new RunnerError('runner_lock_invalid', { fatal: true });
    await ensurePrivateAcl(path, 'runner_lock_invalid', { expectedStat: info });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('runner_lock_invalid', { fatal: true });
  }
}

function waitUntilLocked(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new RunnerError('runner_lock_failed', { fatal: true })), 2_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onError = () => finish(new RunnerError('runner_lock_failed', { fatal: true }));
    const onExit = (code) => finish(new RunnerError(code === 75 ? 'runner_already_running' : 'runner_lock_failed', { fatal: true }));
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 16 || (!'ready\n'.startsWith(output) && output !== 'ready\n')) {
        finish(new RunnerError('runner_lock_failed', { fatal: true }));
      } else if (output === 'ready\n') finish();
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new RunnerError('runner_lock_release_failed', { fatal: true }));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/**
 * macOS lockf or Linux flock holds a kernel advisory lock for the lifetime of
 * lock-holder.
 * The private lock file is deliberately retained, avoiding unlink/reacquire races.
 */
export async function acquireRunnerLock(workRoot) {
  const path = join(workRoot, LOCK_NAME);
  const existed = await existingLock(path);
  const [command, args] = lockCommand(path);
  const child = spawn(command, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  try {
    await waitUntilLocked(child);
    if (!existed) {
      await chmod(path, 0o600);
      await ensurePrivateAcl(path, 'runner_lock_invalid', { normalize: true });
    }
    const acquired = await lstat(path);
    if (!acquired.isFile() || acquired.isSymbolicLink() || acquired.uid !== process.getuid()
      || (acquired.mode & 0o777) !== 0o600) throw new RunnerError('runner_lock_invalid', { fatal: true });
    await ensurePrivateAcl(path, 'runner_lock_invalid', { expectedStat: acquired });
    let released = false;
    let releasing = false;
    const lost = new AbortController();
    child.once('exit', () => {
      if (!released && !releasing) lost.abort(new RunnerError('runner_lock_lost', { fatal: true }));
    });
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      lost.abort(new RunnerError('runner_lock_lost', { fatal: true }));
    }
    return {
      signal: lost.signal,
      holderPid: child.pid,
      async assertHeld() {
        if (released || lost.signal.aborted || child.exitCode !== null || child.signalCode !== null || child.killed) {
          throw new RunnerError('runner_lock_invalid', { fatal: true });
        }
        const current = await lstat(path);
        if (current.dev !== acquired.dev || current.ino !== acquired.ino || !current.isFile()
          || current.isSymbolicLink() || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) {
          throw new RunnerError('runner_lock_invalid', { fatal: true });
        }
        await ensurePrivateAcl(path, 'runner_lock_invalid', { expectedStat: current });
      },
      async release() {
        if (released) return;
        releasing = true;
        const lostBeforeRelease = lost.signal.aborted || child.exitCode !== null
          || child.signalCode !== null || child.killed;
        child.stdin.end();
        try {
          if (await waitForExit(child, 2_000) !== 0 || lostBeforeRelease) {
            throw new RunnerError('runner_lock_release_failed', { fatal: true });
          }
        } finally {
          released = true;
          releasing = false;
        }
      },
    };
  } catch (error) {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => {});
    throw error instanceof RunnerError ? error : new RunnerError('runner_lock_failed', { fatal: true });
  }
}

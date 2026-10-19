// A separate process sets umask without mutating a concurrent adapter's process.
// It shares its process group with the sidecar so the caller can stop the whole tree.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

process.umask(0o077);
// Keep the group leader alive until the sidecar exits. The caller sends TERM
// to the entire group, then KILL after its grace period if the sidecar ignores it.
// The owner may die before it can signal this detached group. Keep an empty,
// private PID marker so startup cleanup never removes a still-active workspace.
closeSync(openSync(join(process.cwd(), `.active-child-${process.pid}`), 'wx', 0o600));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  }, 1000);
  try { process.kill(-process.pid, 'SIGTERM'); } catch { process.exit(1); }
}
process.on('SIGTERM', stop);
process.stdin.resume();
process.stdin.once('end', stop);
process.stdin.once('error', stop);
const [binary, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', () => { if (!stopping) process.exit(127); });
child.on('exit', (code) => { if (!stopping) process.exit(code ?? 1); });

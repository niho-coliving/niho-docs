import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupStaleAttempts } from '../cleanup.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(check) {
  for (let i = 0; i < 160; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('owned child did not reach the expected lifecycle state');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'niho-parent-death-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const workRoot = await mkdtemp(join(root, 'work-'));
  await chmod(workRoot, 0o700);
  return { root, workRoot };
}

test('startup cleanup preserves active child markers and removes an exited child workspace', async (t) => {
  const { workRoot } = await fixture(t);
  const attempt = await mkdtemp(join(workRoot, 'attempt-'));
  await chmod(attempt, 0o700);
  const marker = join(attempt, `.active-child-${process.pid}`);
  await writeFile(marker, '', { mode: 0o600 });
  assert.deepEqual(await cleanupStaleAttempts({ workRoot, singleInstanceConfirmed: true }), {
    removedAttempts: 0, skippedEntries: 1, activeAttempts: 1,
  });
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(exited, 'exit');
  await rm(marker);
  await writeFile(join(attempt, `.active-child-${exited.pid}`), '', { mode: 0o600 });
  assert.equal((await cleanupStaleAttempts({ workRoot, singleInstanceConfirmed: true })).removedAttempts, 1);
});

for (const throughEngine of [false, true]) {
  test(`owner SIGKILL stops a TERM-resistant private child${throughEngine ? ' through the audio engine' : ''}`, {
    skip: process.platform === 'win32' || (throughEngine && (process.platform !== 'darwin' || process.arch !== 'arm64')),
  }, async (t) => {
    const { root, workRoot } = await fixture(t);
    const input = join(root, 'input.wav');
    const wave = Buffer.alloc(44); wave.write('RIFF'); wave.writeUInt32LE(36, 4); wave.write('WAVE', 8);
    await writeFile(input, wave, { mode: 0o600 });
    const audit = join(root, 'audit.json');
    const sidecar = join(root, 'speech');
    await writeFile(sidecar, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
if (process.argv[2] === 'version') console.log(JSON.stringify({name:'niho-speech',version:'0.2.0'}));
else { writeFileSync(${JSON.stringify(audit)},JSON.stringify({pid:process.pid}),{mode:384}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
`, { mode: 0o700 });
    const attempt = throughEngine ? null : await mkdtemp(join(workRoot, 'attempt-'));
    if (attempt) await chmod(attempt, 0o700);
    const ownerFile = join(root, 'owner.mjs');
    const engine = new URL('../engine.mjs', import.meta.url).href;
    const helper = fileURLToPath(new URL('../private-child.mjs', import.meta.url));
    await writeFile(ownerFile, throughEngine
      ? `import { transcribeAudio } from ${JSON.stringify(engine)}; await transcribeAudio(${JSON.stringify({ inputPath: input, sidecarPath: sidecar, workRoot })});`
      : `import { spawn } from 'node:child_process'; spawn(process.execPath,${JSON.stringify([helper, sidecar, 'convert'])},{cwd:${JSON.stringify(attempt)},detached:true,stdio:['pipe','ignore','ignore']}); setInterval(()=>{},1000);`, { mode: 0o600 });
    const owner = spawn(process.execPath, [ownerFile], { stdio: 'ignore' });
    const ownerExited = once(owner, 'exit');
    let helperPid;
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await ownerExited;
      if (helperPid && alive(helperPid)) {
        try { process.kill(-helperPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    const speechPid = await until(async () => {
      try { return JSON.parse(await readFile(audit, 'utf8')).pid; }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    });
    const stage = attempt ?? join(workRoot, (await readdir(workRoot)).find((name) => name.startsWith('attempt-')));
    for (const name of await readdir(stage)) {
      const match = /^\.active-child-(\d+)$/.exec(name);
      if (match && alive(Number(match[1]))) helperPid = Number(match[1]);
    }
    assert.ok(helperPid);
    assert.equal((await cleanupStaleAttempts({ workRoot, singleInstanceConfirmed: true })).activeAttempts, 1);
    owner.kill('SIGKILL');
    await ownerExited;
    await until(() => !alive(helperPid) && !alive(speechPid));
    assert.equal((await cleanupStaleAttempts({ workRoot, singleInstanceConfirmed: true })).removedAttempts, 1);
    assert.deepEqual(await readFile(input), wave);
  });
}

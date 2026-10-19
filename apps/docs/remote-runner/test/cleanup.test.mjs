import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupStaleAttempts } from '../cleanup.mjs';

async function root(t) {
  const path=await mkdtemp(join(tmpdir(),'niho-cleanup-test-'));
  await chmod(path,0o700);
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}

test('startup recovery removes only private owned attempt trees and preserves unknown names/symlinks',async t=>{
  const workRoot=await root(t);
  const attempt=await mkdtemp(join(workRoot,'attempt-'));
  await mkdir(join(attempt,'temp'),{mode:0o700});
  await writeFile(join(attempt,'temp','audio.wav'),'private',{mode:0o600});
  const foreign=join(workRoot,'other-project'); await mkdir(foreign,{mode:0o700});
  await writeFile(join(foreign,'keep'),'keep',{mode:0o600});
  await symlink(foreign,join(workRoot,'attempt-Link01'));
  await writeFile(join(workRoot,'attempt-File01'),'keep',{mode:0o600});
  const publicDir=join(workRoot,'attempt-Publ01'); await mkdir(publicDir,{mode:0o755}); await chmod(publicDir,0o755);
  const unsafeTree=join(workRoot,'attempt-Unsafe'); await mkdir(unsafeTree,{mode:0o700});
  await symlink(foreign,join(unsafeTree,'linked'));
  assert.deepEqual(await cleanupStaleAttempts({workRoot,singleInstanceConfirmed:true}),{removedAttempts:1,skippedEntries:5});
  assert.equal((await readdir(workRoot)).length,5);
  assert.equal(await readFile(join(foreign,'keep'),'utf8'),'keep');
  assert.equal(await readFile(join(workRoot,'attempt-Link01','keep'),'utf8'),'keep');
});

test('recovery requires explicit idle single-instance acknowledgement and a private owned non-symlink root',async t=>{
  const workRoot=await root(t);
  const attempt=await mkdtemp(join(workRoot,'attempt-'));
  await assert.rejects(cleanupStaleAttempts({workRoot}),{code:'invalid_configuration'});
  const link=join(workRoot,'root-link'); await symlink(workRoot,link);
  await assert.rejects(cleanupStaleAttempts({workRoot:link,singleInstanceConfirmed:true}),{code:'workspace_invalid'});
  await chmod(workRoot,0o755);
  await assert.rejects(cleanupStaleAttempts({workRoot,singleInstanceConfirmed:true}),{code:'workspace_invalid'});
  await chmod(workRoot,0o700);
  assert.ok((await readdir(workRoot)).includes(attempt.split('/').at(-1)));
});

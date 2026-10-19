import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateAcl, parseMacosAclOutput } from '../acl.mjs';

const clean = 'drwx------  1 user staff 32 Jan 1 12:00 /tmp/runner';
const shared = `${clean.replace('drwx------','drwx------+')}\n 0: group:everyone allow read,readattr\n`;
const denied = `${clean.replace('drwx------','drwx------+')}\n 0: group:everyone deny delete\n`;

test('macOS ls ACL output is parsed and malformed output fails closed',()=>{
  assert.deepEqual(parseMacosAclOutput(`${clean}\n`),{hasAcl:false,allowsAccess:false});
  assert.deepEqual(parseMacosAclOutput(shared),{hasAcl:true,allowsAccess:true});
  assert.deepEqual(parseMacosAclOutput(denied),{hasAcl:true,allowsAccess:false});
  assert.equal(parseMacosAclOutput(`${clean.replace('drwx------','drwx------+')}\n`),undefined);
  assert.equal(parseMacosAclOutput('unexpected output'),undefined);
});

test('caller-owned ACL is rejected without mutation and inherited attempt ACL is cleared',async t=>{
  const root=await mkdtemp(join(tmpdir(),'niho-acl-test-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'private');
  await writeFile(path,'private',{mode:0o600});
  const expectedStat=await lstat(path);
  let acl=shared;
  const calls=[];
  const runFile=async (command,args)=>{
    calls.push([command,args]);
    if(command==='/bin/chmod') { acl=`${clean}\n`; return {stdout:'',stderr:''}; }
    return {stdout:acl,stderr:''};
  };

  await assert.rejects(
    ensurePrivateAcl(path,'input_not_private',{platform:'darwin',expectedStat,runFile}),
    error=>error.code==='input_not_private',
  );
  assert.equal(await readFile(path,'utf8'),'private');
  await ensurePrivateAcl(path,'workspace_invalid',{platform:'darwin',expectedStat,normalize:true,runFile});
  assert.deepEqual(calls.map(([command])=>command),['/bin/ls','/bin/ls','/bin/chmod','/bin/ls']);
});

test('deny-only ACL is accepted for caller-owned files and removed from new attempts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'niho-acl-deny-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'private');
  await writeFile(path,'private',{mode:0o600});
  const expectedStat=await lstat(path);
  let acl=denied;
  const calls=[];
  const runFile=async (command,args)=>{
    calls.push([command,args]);
    if(command==='/bin/chmod') { acl=`${clean}\n`; return {stdout:'',stderr:''}; }
    return {stdout:acl,stderr:''};
  };
  await ensurePrivateAcl(path,'input_not_private',{platform:'darwin',expectedStat,runFile});
  await ensurePrivateAcl(path,'workspace_invalid',{platform:'darwin',expectedStat,normalize:true,runFile});
  assert.deepEqual(calls.map(([command])=>command),['/bin/ls','/bin/ls','/bin/chmod','/bin/ls']);
});

test('ACL inspection failures become fixed diagnostic codes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'niho-acl-failure-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(
    ensurePrivateAcl(root,'workspace_invalid',{platform:'darwin',runFile:async()=>{throw new Error('private path');}}),
    error=>error.code==='workspace_invalid'&&error.message==='workspace_invalid',
  );
});

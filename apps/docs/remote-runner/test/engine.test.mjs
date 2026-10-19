import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, preflightSpeech, transcribeAudio, workspaceBytes } from '../engine.mjs';

const AUDIO = Buffer.alloc(44);
AUDIO.write('RIFF',0); AUDIO.writeUInt32LE(36,4); AUDIO.write('WAVE',8);

async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'niho-runner-test-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const workRoot = join(root, 'attempts');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workRoot, { mode: 0o700 });
  const inputPath = join(root, 'private.audio');
  await writeFile(inputPath, AUDIO, { mode: 0o600 });
  const sidecarPath = join(root, 'speech;no-shell');
  const audit = join(root, 'audit.jsonl');
  await writeFile(sidecarPath, `#!${process.execPath}
import { appendFileSync, writeFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const command = args[0];
const value = key => args[args.indexOf(key)+1];
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
appendFileSync(${JSON.stringify(audit)}, JSON.stringify({command,args,env:process.env,mode:statSync(process.cwd()).mode&511})+'\\n', {mode:384});
if (command === 'version') emit(config.version ?? {name:'niho-speech', version:'0.2.0'});
else if (command === 'probe') emit(config.probe ?? {available:true,needsDownload:false,engine:'SpeechAnalyzer',locale:'ja_JP',diarization:{state:'ready',detail:null}});
else if (command === 'convert') {
  if (!value('--input').endsWith('.'+(config.expectedExtension??'wav'))) { emit({type:'error',code:'input_unreadable'}); process.exit(3); }
  writeFileSync(value('--output'), Buffer.alloc(config.wavBytes ?? 44));
  if (config.publicWav) { const {chmodSync}=await import('node:fs'); chmodSync(value('--output'),420); }
  if (config.convertHang) { setInterval(()=>{},1000); } else emit(config.convert ?? {durationSec:95});
} else if (command === 'diarize') {
  if (config.diarizeError) { emit({type:'error',code:'diarization_failed'}); process.exit(3); }
  if (!config.skipSpeakerMap) writeFileSync(value('--output'), JSON.stringify({version:1,duration:95,turns:[{start:0,end:95,id:1}]}), {mode:384});
  emit(config.diarize ?? {ok:true,turns:1});
} else if (command === 'silence') emit(config.silence ?? {cuts:[],durationSec:95});
else if (command === 'transcribe') {
  if (config.hang) {
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs');const trigger=" + JSON.stringify(${JSON.stringify(join(root, 'termination-check'))}) + ";const escaped=" + JSON.stringify(${JSON.stringify(join(root, 'escaped'))}) + ";process.on('SIGTERM',()=>{});setInterval(()=>{if(fs.existsSync(trigger)){fs.writeFileSync(escaped,'survived');process.exit(0)}},10)"], {stdio:'ignore'});
    writeFileSync(${JSON.stringify(join(root, 'descendant.pid'))}, String(descendant.pid), {mode:384});
    setInterval(()=>{},1000);
  } else if (config.rawHex !== undefined) process.stdout.write(Buffer.from(config.rawHex,'hex'));
  else if (config.raw !== undefined) process.stdout.write(config.raw);
  else {
    const start = Number(value('--start'));
    const events = config.events ?? [{type:'segment',start:start+1,end:start+2,text:'こんにちは。  本文です。'},{type:'done',segments:1,durationMs:7}];
    if (config.errorHang) process.on('SIGTERM',()=>{});
    for (const event of events) emit(config.relativeEvents && event.type === 'segment' ? {...event,start:event.start+start,end:event.end+start} : event);
    if (config.errorHang) setInterval(()=>{},1000);
  }
}
`, { mode: 0o700 });
  const options = { inputPath, sidecarPath, workRoot, limits: { monitorMs: 10, killGraceMs: 30 } };
  const clean = async () => {
    assert.deepEqual(await readdir(workRoot), []);
    assert.deepEqual(await readFile(inputPath), AUDIO);
  };
  return { root, options, clean, audit };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('timestamped result uses absolute chunk timestamps, hash, metadata; workspace is cleaned', async t => {
  const f = await fixture(t, { silence: { cuts: [60], durationSec: 95 } });
  process.env.NIHO_RUNNER_SECRET_TEST = 'must-not-inherit';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => { delete process.env.NIHO_RUNNER_SECRET_TEST; delete process.env.NODE_OPTIONS; });
  const result = await transcribeAudio(f.options);
  assert.deepEqual(result.source, { bytes: 44, format:'wav', sha256: createHash('sha256').update(AUDIO).digest('hex') });
  assert.deepEqual(result.engine, { name: 'SpeechAnalyzer', sidecar: 'niho-speech', version: '0.2.0' });
  assert.equal(result.durationSec, 95);
  assert.equal(result.processingMs, 14);
  assert.deepEqual(result.segments.map(s => s.start), [1, 61]);
  assert.equal(result.markdown, '[00:00:01] こんにちは。 本文です。\n\n[00:01:01] こんにちは。 本文です。\n');
  const audit = (await readFile(f.audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(a => a.command), ['version','convert','silence','transcribe','transcribe']);
  for (const a of audit) {
    assert.equal(a.mode, 0o700);
    assert.equal(a.env.NIHO_RUNNER_SECRET_TEST, undefined);
    assert.equal(a.env.NODE_OPTIONS, undefined);
    assert.equal(a.env.PATH, '/usr/bin:/bin');
  }
  await f.clean();
});

test('read-only preflight returns platform, pinned sidecar and installed model state', async t => {
  const f = await fixture(t);
  const result = await preflightSpeech(f.options);
  assert.equal(result.platform.os, 'darwin');
  assert.equal(result.platform.arch, 'arm64');
  assert.equal(result.engine.version, '0.2.0');
  assert.equal(result.locale, 'ja_JP');
  assert.equal(result.available, true);
  assert.equal(result.needsDownload, false);
  assert.deepEqual((await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse).map(a => a.command), ['version','probe']);
  await f.clean();
});

test('話者 mode は全体 WAV を一度だけ diarize し、全 chunk に同じ speaker map を渡す', async t => {
  const events = [{type:'segment',start:1,end:2,text:'本文',speaker:2},{type:'done',segments:1,durationMs:7}];
  const f = await fixture(t, { silence:{cuts:[60],durationSec:95}, events, relativeEvents:true });
  const result = await transcribeAudio({...f.options,speakerMode:'2'});
  assert.equal(result.markdown,'[00:00:01] 話者2: 本文\n\n[00:01:01] 話者2: 本文\n');
  assert.deepEqual(result.segments.map(segment=>segment.speaker),[2,2]);
  const audit=(await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter(row=>row.command==='diarize').length,1);
  const diarize=audit.find(row=>row.command==='diarize');
  assert.deepEqual(diarize.args.slice(-2),['--speakers','2']);
  const maps=audit.filter(row=>row.command==='transcribe').map(row=>row.args[row.args.indexOf('--speaker-map')+1]);
  assert.equal(new Set(maps).size,1);
  assert.ok(maps[0]?.endsWith('/speakers.json'));
  await f.clean();
});

test('auto は人数制約なし、4plus は最小4人、diarize/話者 protocol 失敗は無ラベルへ降格しない', async t => {
  for (const [speakerMode,tail] of [['auto',[]],['4plus',['--minimum-speakers','4']]]) {
    const f=await fixture(t,{events:[{type:'segment',start:1,end:2,text:'本文',speaker:null},{type:'done',segments:1,durationMs:1}]});
    const result=await transcribeAudio({...f.options,speakerMode});
    const row=(await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse).find(item=>item.command==='diarize');
    assert.deepEqual(tail.length ? row.args.slice(-2) : row.args.filter(arg=>arg==='--speakers'||arg==='--minimum-speakers'),tail);
    assert.equal(result.markdown,'[00:00:01] 話者?: 本文\n');
    await f.clean();
  }
  for (const config of [
    {diarizeError:true}, {skipSpeakerMap:true},
    {events:[{type:'segment',start:1,end:2,text:'本文'},{type:'done',segments:1,durationMs:1}]},
    {events:[{type:'segment',start:1,end:2,text:'本文',speaker:0},{type:'done',segments:1,durationMs:1}]},
  ]) {
    const f=await fixture(t,config);
    await rejectsCode(transcribeAudio({...f.options,speakerMode:'auto'}), config.diarizeError?'sidecar_failed':'sidecar_protocol');
    await f.clean();
  }
});

test('preflight fails closed for unavailable models and malformed metadata', async t => {
  for (const [config, code] of [
    [{probe:{available:true,needsDownload:true,engine:'SpeechAnalyzer',locale:'ja_JP',diarization:{state:'ready',detail:null}}},'model_missing'],
    [{probe:{available:false,needsDownload:false,engine:'SpeechAnalyzer',locale:null,diarization:{state:'ready',detail:null}}},'engine_unavailable'],
    [{probe:{available:'true',needsDownload:false,engine:'SpeechAnalyzer',locale:'ja_JP',diarization:{state:'ready',detail:null}}},'sidecar_protocol'],
    [{probe:{available:true,needsDownload:false,engine:'Other',locale:'ja_JP',diarization:{state:'ready',detail:null}}},'sidecar_protocol'],
    [{probe:{available:true,needsDownload:false,engine:'SpeechAnalyzer',locale:'en_US',diarization:{state:'ready',detail:null}}},'sidecar_protocol'],
    [{probe:{available:true,needsDownload:false,engine:'SpeechAnalyzer',locale:'ja_JP',diarization:{state:'missing',detail:null}}},'sidecar_protocol'],
    [{version:{name:'niho-speech',version:'secret https://example.invalid'}},'sidecar_protocol'],
  ]) {
    const f = await fixture(t, config);
    await rejectsCode(preflightSpeech(f.options), code);
    await f.clean();
  }
});

test('input byte ceiling rejects before launching sidecar and cannot be raised', async t => {
  const f = await fixture(t);
  assert.equal(DEFAULT_LIMITS.maxInputBytes, 2 * 1024 ** 3);
  await rejectsCode(transcribeAudio({...f.options, limits: {...f.options.limits,maxInputBytes: 12}}), 'input_limit');
  await assert.rejects(readFile(f.audit), {code:'ENOENT'});
  await rejectsCode(transcribeAudio({...f.options,limits:{maxInputBytes:DEFAULT_LIMITS.maxInputBytes+1}}),'invalid_configuration');
  await rejectsCode(transcribeAudio({...f.options,limits:{minFreeBytes:DEFAULT_LIMITS.minFreeBytes+0.5}}),'invalid_configuration');
  // Sparse file makes the real C0 boundary test constant disk cost.
  await truncate(f.options.inputPath, DEFAULT_LIMITS.maxInputBytes + 1);
  await rejectsCode(transcribeAudio(f.options),'input_limit');
  assert.deepEqual(await readdir(f.options.workRoot),[]);
});

test('rejects non-private input and root without changing caller permissions', async t => {
  const f = await fixture(t);
  await chmod(f.options.inputPath,0o644);
  await rejectsCode(transcribeAudio(f.options),'input_not_private');
  assert.equal((await stat(f.options.inputPath)).mode&0o777,0o644);
  await chmod(f.options.inputPath,0o600);
  await chmod(f.options.workRoot,0o755);
  await rejectsCode(transcribeAudio(f.options),'workspace_invalid');
  assert.equal((await stat(f.options.workRoot)).mode&0o777,0o755);
  await f.clean();
});

test('rejects duration, intermediate byte, free disk and file permission violations', async t => {
  for (const [config,limits,code] of [
    [{convert:{durationSec:21600.01}}, {}, 'duration_limit'],
    [{convert:{durationSec:0}}, {}, 'sidecar_protocol'],
    [{wavBytes:100}, {maxWorkspaceBytes:60}, 'workspace_limit'],
    [{wavBytes:100,convert:{durationSec:0.001}}, {maxDurationSec:0.001}, 'workspace_limit'],
    [{}, {minFreeBytes:Number.MAX_SAFE_INTEGER}, 'disk_limit'],
    [{publicWav:true}, {}, 'workspace_invalid'],
  ]) {
    const f = await fixture(t,config);
    await rejectsCode(transcribeAudio({...f.options,limits:{...f.options.limits,...limits}}),code);
    await f.clean();
  }
});

test('strict JSONL rejects malformed, missing, duplicate and mismatched done; invalid segment/progress; speaker', async t => {
  const segment={type:'segment',start:1,end:2,text:'private secret https://example.invalid'};
  const done={type:'done',segments:1,durationMs:1};
  for (const config of [
    {rawHex:'ff0a'}, {raw:'not json\n'}, {raw:'{"type":"done"}\n'}, {raw:'{"type":"done","segments":0,"durationMs":1}'},
    {events:[segment]}, {events:[segment,done,done]}, {events:[segment,{...done,segments:2}]},
    {events:[done,segment]}, {events:[{...segment,start:-1},done]}, {events:[{...segment,end:96},done]},
    {events:[{...segment,speaker:'invented'},done]}, {events:[{type:'progress',ratio:2},done]},
  ]) {
    const f = await fixture(t,config);
    await rejectsCode(transcribeAudio(f.options),'sidecar_protocol');
    await f.clean();
  }
});

test('invalid cuts and stdout limits fail closed and remove the private workspace', async t => {
  for (const [config,limits,code] of [
    [{silence:{cuts:[60,60],durationSec:95}}, {},'sidecar_protocol'],
    [{silence:{cuts:[],durationSec:90}}, {},'sidecar_protocol'],
    [{raw:'x'.repeat(2000)}, {maxLineBytes:100},'output_limit'],
    [{raw:'x'.repeat(2000)+'\n'}, {maxOutputBytes:1000},'output_limit'],
  ]) {
    const f = await fixture(t,config);
    await rejectsCode(transcribeAudio({...f.options,limits:{...f.options.limits,...limits}}),code);
    await f.clean();
  }
});

test('timeout and cancellation stop a TERM-resistant sidecar and descendant before cleanup', async t => {
  for (const cancel of [false,true]) {
    const f = await fixture(t,{hang:true});
    const controller = new AbortController();
    const pending = transcribeAudio({...f.options,signal:controller.signal,limits:{...f.options.limits,timeoutMs:cancel?4000:1800}});
    if (cancel) {
      for (let i=0;i<150;i++) {
        if ((await readdir(f.root)).includes('descendant.pid')) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      controller.abort();
    }
    await rejectsCode(pending,cancel?'cancelled':'timeout');
    await f.clean();
    assert.ok((await readdir(f.root)).includes('descendant.pid'));
    // Ask the descendant to escape only after the parent reports termination; this avoids a startup-timing race.
    await writeFile(join(f.root,'termination-check'),'check');
    await new Promise(resolve => setTimeout(resolve,250));
    await assert.rejects(readFile(join(f.root,'escaped')),{code:'ENOENT'});
  }
});

test('already cancelled attempt never allocates a workspace or starts sidecar', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await rejectsCode(transcribeAudio({...f.options,signal:controller.signal}),'cancelled');
  await assert.rejects(readFile(f.audit),{code:'ENOENT'});
  await f.clean();
});


test('rejects unknown format before sidecar; all-silent and whitespace-only transcripts fail closed', async t => {
  const unknown = await fixture(t);
  await writeFile(unknown.options.inputPath,'not an audio file');
  await rejectsCode(transcribeAudio(unknown.options),'input_format');
  await assert.rejects(readFile(unknown.audit),{code:'ENOENT'});
  assert.deepEqual(await readdir(unknown.options.workRoot),[]);
  for (const events of [
    [{type:'done',segments:0,durationMs:1}],
    [{type:'segment',start:1,end:2,text:'  \n '},{type:'done',segments:1,durationMs:1}],
  ]) {
    const f = await fixture(t,{events});
    await rejectsCode(transcribeAudio(f.options),'silent_audio');
    await f.clean();
  }
});

test('live resource monitor terminates conversion exceeding its workspace budget', async t => {
  const f = await fixture(t,{wavBytes:100,convertHang:true});
  await rejectsCode(transcribeAudio({...f.options,limits:{...f.options.limits,maxWorkspaceBytes:100}}),'workspace_limit');
  await f.clean();
});

test('workspace scan tolerates a temporary file renamed after readdir',async t=>{
  const root=await mkdtemp(join(tmpdir(),'niho-workspace-race-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const partial=join(root,'.audio.wav.partial-123');
  const complete=join(root,'audio.wav');
  await writeFile(partial,'partial',{mode:0o600});
  let removed=false;
  const inspectPath=async path=>{
    if(path===partial&&!removed) {removed=true;await rename(path,complete);}
    return lstat(path);
  };
  assert.equal(await workspaceBytes(root,inspectPath),0);
  assert.equal(removed,true);
  assert.equal(await workspaceBytes(root),7);
});

test('preflight rejects unsupported OS or architecture before starting sidecar', async t => {
  const f = await fixture(t);
  for (const [key,value] of [['platform','linux'],['arch','x64']]) {
    const descriptor = Object.getOwnPropertyDescriptor(process,key);
    try {
      Object.defineProperty(process,key,{value,configurable:true});
      await rejectsCode(preflightSpeech(f.options),'unsupported_platform');
    } finally { Object.defineProperty(process,key,descriptor); }
  }
  await assert.rejects(readFile(f.audit),{code:'ENOENT'});
  await f.clean();
});


test('known sidecar errors become fixed diagnostic codes and discard private messages', async t => {
  for (const [code,expected] of [
    ['model_not_installed','model_missing'], ['engine_unavailable','engine_unavailable'],
    ['unsupported_language','language_unsupported'],
    ['input_unreadable','input_invalid'], ['input_too_large','input_limit'],
    ['permission_denied','resource_unavailable'], ['write_failed','resource_unavailable'],
    ['unknown https://secret.invalid','sidecar_failed'],
  ]) {
    const f = await fixture(t,{events:[{type:'error',code,message:'private secret https://example.invalid'}]});
    await rejectsCode(transcribeAudio(f.options),expected);
    await f.clean();
  }
});


test('symlink input is refused and neither link nor original is deleted', async t => {
  const f = await fixture(t);
  const link = join(f.root,'linked.audio');
  await symlink(f.options.inputPath,link);
  await rejectsCode(transcribeAudio({...f.options,inputPath:link}),'transcription_failed');
  assert.deepEqual(await readFile(link),AUDIO);
  await f.clean();
});


test('terminal sidecar error wins over cancellation while its TERM-resistant process is reaped', async t => {
  const f = await fixture(t,{
    errorHang:true,
    events:[{type:'error',code:'input_unreadable',message:'private https://secret.invalid'}],
  });
  const controller = new AbortController();
  const originalKill = process.kill;
  let cancellationScheduled = false;
  process.kill = function(pid,signal) {
    const result = originalKill.call(process,pid,signal);
    if (signal === 'SIGTERM' && !cancellationScheduled) {
      cancellationScheduled=true;
      setTimeout(()=>controller.abort(),10);
    }
    return result;
  };
  try {
    await rejectsCode(transcribeAudio({
      ...f.options,signal:controller.signal,
      limits:{...f.options.limits,killGraceMs:300},
    }),'input_invalid');
    assert.equal(cancellationScheduled,true);
    assert.equal(controller.signal.aborted,true);
    await f.clean();
  } finally { process.kill = originalKill; }
});


test('real sidecar transcribes ja-sample.m4a with a signature-derived M4A filename', {
  skip: process.env.NIHO_SPEECH_E2E !== '1' || !process.env.NIHO_SPEECH_TEST_FIXTURE,
}, async t => {
  const f = await fixture(t);
  const source = process.env.NIHO_SPEECH_TEST_FIXTURE;
  const audio = await readFile(source);
  await writeFile(f.options.inputPath,audio,{mode:0o600});
  const sidecarPath = process.env.NIHO_SPEECH_TEST_BINARY
    ?? fileURLToPath(new URL('../../sidecar/niho-speech/.build/release/niho-speech',import.meta.url));
  const options = {...f.options,sidecarPath,limits:{timeoutMs:60000}};
  const readiness = await preflightSpeech(options);
  assert.equal(readiness.needsDownload,false);
  const result = await transcribeAudio(options);
  assert.equal(result.source.format,'m4a');
  assert.equal(result.source.sha256,createHash('sha256').update(audio).digest('hex'));
  assert.ok(Math.abs(result.durationSec-13.35)<0.2);
  assert.ok(result.segments.length>0);
  assert.match(result.markdown,/^\[\d{2}:\d{2}:\d{2}\] /);
  assert.deepEqual(await readdir(f.options.workRoot),[]);
  assert.deepEqual(await readFile(f.options.inputPath),audio);
});


test('container inspection selects .m4a for an input with an unrelated filename', async t => {
  const f = await fixture(t,{expectedExtension:'m4a'});
  const audio=await readFile(fileURLToPath(new URL('../../fixtures/audio/synthetic-tone.m4a',import.meta.url)));
  await writeFile(f.options.inputPath,audio,{mode:0o600});
  const result=await transcribeAudio(f.options);
  assert.equal(result.source.format,'m4a');
  assert.equal(result.source.sha256,createHash('sha256').update(audio).digest('hex'));
  const commands=(await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse);
  const convert=commands.find(c=>c.command==='convert');
  assert.match(convert.args[convert.args.indexOf('--input')+1],/\/input\.m4a$/);
  assert.deepEqual(await readdir(f.options.workRoot),[]);
  assert.deepEqual(await readFile(f.options.inputPath),audio);
});


test('AIFC magic selects .aifc without admitting AIFF as an alias', async t => {
  const f = await fixture(t,{expectedExtension:'aifc'});
  const audio=Buffer.from('FORM\0\0\0\0AIFCCOMM');
  await writeFile(f.options.inputPath,audio,{mode:0o600});
  const result=await transcribeAudio(f.options);
  assert.equal(result.source.format,'aifc');
  assert.equal(result.source.sha256,createHash('sha256').update(audio).digest('hex'));
  const commands=(await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse);
  const convert=commands.find(c=>c.command==='convert');
  assert.ok(convert.args[convert.args.indexOf('--input')+1].endsWith('/input.aifc'));
  assert.deepEqual(await readdir(f.options.workRoot),[]);
  assert.deepEqual(await readFile(f.options.inputPath),audio);
});


test('AAC/FLAC/Ogg inspection selects a codec-derived extension before sidecar conversion',async t=>{
  const {adts,flac,ogg}=await import('./audio-fixtures.mjs');
  for(const [content,format] of [[adts(),'aac'],[flac(),'flac'],[ogg(),'ogg'],[ogg('opus'),'ogg']]) {
    const f=await fixture(t,{expectedExtension:format});
    await writeFile(f.options.inputPath,content,{mode:0o600});
    const result=await transcribeAudio(f.options);
    assert.equal(result.source.format,format);
    assert.equal(result.source.sha256,createHash('sha256').update(content).digest('hex'));
    const commands=(await readFile(f.audit,'utf8')).trim().split('\n').map(JSON.parse);
    const convert=commands.find(c=>c.command==='convert');
    assert.ok(convert.args[convert.args.indexOf('--input')+1].endsWith('/input.'+format));
    assert.deepEqual(await readdir(f.options.workRoot),[]);
    assert.deepEqual(await readFile(f.options.inputPath),content);
  }
});


test('a source declared above 1 GiB is judged by its real bytes and hash, not rejected as an invalid snapshot', async t => {
  const f = await fixture(t);
  const sha256 = createHash('sha256').update(AUDIO).digest('hex');
  for (const bytes of [1024 ** 3 + 1, 1_975_615_488, 2 * 1024 ** 3]) {
    await rejectsCode(transcribeAudio({ ...f.options, expectedSource: { sha256, bytes } }), 'snapshot_mismatch');
    await f.clean();
  }
  await rejectsCode(transcribeAudio({ ...f.options, expectedSource: { sha256, bytes: 2 * 1024 ** 3 + 1 } }), 'snapshot_invalid');
  await f.clean();
});

// 本物の 1.84 GiB（1,975,615,488 byte。#18649 のインタビュー AIFC と同じ大きさ）を 64 KiB ずつ複写・hash して sidecar（偽）まで通す。
// 作業用の 1.84 GiB を実際に書くので、既定では走らせず NIHO_RUNNER_LARGE_INPUT=1 のときだけ走る。
test('a real 1.84 GiB AIFC is copied, hashed and converted under the 2 GiB ceiling', { skip: process.env.NIHO_RUNNER_LARGE_INPUT !== '1' }, async t => {
  const size = 1_975_615_488;
  const f = await fixture(t, { expectedExtension: 'aifc' });
  const head = Buffer.from('FORM\0\0\0\0AIFCCOMM');
  await writeFile(f.options.inputPath, head, { mode: 0o600 });
  await truncate(f.options.inputPath, size);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(f.options.inputPath)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const result = await transcribeAudio({ ...f.options, expectedSource: { sha256, bytes: size } });
  assert.equal(result.source.format, 'aifc');
  assert.equal(result.source.bytes, size);
  assert.equal(result.source.sha256, sha256);
  assert.deepEqual(await readdir(f.options.workRoot), []);
  assert.equal((await stat(f.options.inputPath)).size, size);
});

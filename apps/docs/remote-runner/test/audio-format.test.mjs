import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxOggPagesForBytes } from '../audio-containers.mjs';
import { audioFormat } from '../audio-format.mjs';

const box = (name, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length+8); head.write(name,4);
  return Buffer.concat([head,data]);
};
function m4a(handler = 'soun',brand = 'M4A ') {
  const h = Buffer.alloc(12); h.write(handler,8);
  return Buffer.concat([
    box('ftyp',Buffer.from(`${brand}\0\0\0\0`)),
    box('moov',box('trak',box('mdia',box('hdlr',h)))),
    box('mdat',Buffer.alloc(16)),
  ]);
}

test('audio signatures allow the C1 audio8 set including AIFC and reject AIFF/video/truncation', async t => {
  const root=await mkdtemp(join(tmpdir(),'niho-format-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const examples = [
    [Buffer.from('RIFF\0\0\0\0WAVEfmt '),'wav'],
    [Buffer.from('FORM\0\0\0\0AIFCCOMM'),'aifc'],
    [Buffer.from('FORM\0\0\0\0AIFFCOMM'),undefined],
    [Buffer.from('caff\0\x01\0\0desc\0\0\0\0'),'caf'],
    [Buffer.from([255,251,144,0,...Array(12).fill(0)]),'mp3'],
    [Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0'),Buffer.from([255,251,144,0])]),'mp3'],
    [m4a(),'m4a'],
    [m4a('vide'),undefined],
    [m4a('soun','mp42'),undefined],
    [m4a('soun','qt  '),undefined],
    [m4a().subarray(0,40),undefined],
    [Buffer.from('RIFF\0\0\0\0AVI LIST'),undefined],
    [Buffer.from('not-audio-file'),undefined],
    [Buffer.from('caff\0\x02\0\0desc\0\0\0\0'),undefined],
    [Buffer.from('ID3\x04\0\0\x7f\x7f\x7f\x7fxx'),undefined],
  ];
  for (let i=0;i<examples.length;i++) {
    const [content,expected]=examples[i];
    const path=join(root,String(i));
    await writeFile(path,content,{mode:0o600});
    const file=await open(path,'r');
    try { assert.equal(await audioFormat(file,content.length),expected,`fixture ${i}`); }
    finally { await file.close(); }
  }
});

async function inspect(t,content,assertActive) {
  const root=await mkdtemp(join(tmpdir(),'niho-container-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'unknown-name'); await writeFile(path,content,{mode:0o600});
  const file=await open(path,'r');
  try { return await audioFormat(file,content.length,assertActive); }
  finally { await file.close(); }
}

test('AAC ADTS validates every frame boundary and distinguishes MP3/truncation/reserved header values',async t=>{
  const {adts}=await import('./audio-fixtures.mjs');
  for(const content of [adts(),adts({crc:true}),Buffer.concat([adts(),adts()]),adts({payload:Buffer.from([1])})]) {
    assert.equal(await inspect(t,content),'aac');
  }
  for(const content of [
    adts().subarray(0,10),
    Buffer.concat([adts(),Buffer.from('unknown trailer')]),
    adts({sampleIndex:15}),adts({channels:0}),
    Buffer.concat([adts(),adts({sampleIndex:3})]),
  ]) assert.equal(await inspect(t,content),undefined);
});

test('FLAC requires STREAMINFO bounds, complete metadata and an audio-frame signature',async t=>{
  const {flac}=await import('./audio-fixtures.mjs');
  assert.equal(await inspect(t,flac()),'flac');
  for(const mutate of [
    b=>b.subarray(0,42),
    b=>{b[4]=129;return b;},
    b=>{b[7]=33;return b;},
    b=>{b.writeUInt16BE(0,8);return b;},
    b=>{b[18]=0;b[19]=0;b[20]&=15;return b;},
    b=>{b[42]=0;return b;},
    b=>{b[4]=0;return b;},
  ]) assert.equal(await inspect(t,mutate(flac())),undefined);
});

test('Ogg accepts Vorbis/Opus and audio-only chained streams; rejects video, unknown streams and broken framing',async t=>{
  const {ogg,oggPage,vorbisHeaders,opusHeaders}=await import('./audio-fixtures.mjs');
  assert.equal(await inspect(t,ogg()),'ogg');
  assert.equal(await inspect(t,ogg('opus')),'ogg');
  assert.equal(await inspect(t,Buffer.concat([ogg(),ogg('opus',8)])),'ogg');
  const video=oggPage({serial:8,flags:2,packets:[Buffer.from([128,...Buffer.from('theora'),0]) ]});
  for(const content of [
    video,
    Buffer.concat([ogg(),video]),
    Buffer.concat([oggPage({flags:2,packets:[vorbisHeaders()[0]]}),video]),
    oggPage({flags:2,packets:[Buffer.from('UnknownAudioCodec')]}),
    ogg().subarray(0,-1),
    ogg().subarray(0,58),
    Buffer.concat([ogg(),Buffer.from('trailing bytes')]),
    oggPage({flags:2,packets:[vorbisHeaders()[0],vorbisHeaders()[1]]}),
    Buffer.concat([oggPage({flags:2,packets:[opusHeaders()[0]]}),oggPage({sequence:2,flags:4,packets:[opusHeaders()[1]]})]),
  ]) assert.equal(await inspect(t,content),undefined);
  const badCrc=ogg(); badCrc[badCrc.length-1]^=1;
  assert.equal(await inspect(t,badCrc),undefined);
});

test('Ogg checks codec header fields and continuation packets instead of trusting capture magic',async t=>{
  const {oggPage,vorbisHeaders,opusHeaders}=await import('./audio-fixtures.mjs');
  const wrap=(id,headers)=>Buffer.concat([
    oggPage({flags:2,packets:[id]}),oggPage({sequence:1,packets:headers}),
    oggPage({sequence:2,flags:4,packets:[Buffer.from([0,1])]}),
  ]);
  const vorbis=vorbisHeaders();
  const badVorbis=Buffer.from(vorbis[0]); badVorbis[11]=0;
  assert.equal(await inspect(t,wrap(badVorbis,vorbis.slice(1))),undefined);
  const opus=opusHeaders();
  const badOpus=Buffer.from(opus[0]); badOpus[9]=3;
  assert.equal(await inspect(t,wrap(badOpus,opus.slice(1))),undefined);
  const surround=Buffer.concat([opus[0],Buffer.from([4,4,0,6,1,2,3,4,5,7])]);
  surround[9]=8; surround[18]=1;
  assert.equal(await inspect(t,wrap(surround,opus.slice(1))),'ogg');
  const badMapping=Buffer.from(surround); badMapping[21]=8;
  assert.equal(await inspect(t,wrap(badMapping,opus.slice(1))),undefined);
  const badTags=Buffer.from(opus[1]); badTags.writeUInt32LE(0xffffffff,8);
  assert.equal(await inspect(t,wrap(opus[0],[badTags])),undefined);
  const longTags=Buffer.concat([opus[1],Buffer.alloc(300)]);
  const continued=Buffer.concat([
    oggPage({flags:2,packets:[opus[0]]}),
    oggPage({sequence:1,laces:[255],body:longTags.subarray(0,255)}),
    oggPage({sequence:2,flags:1,laces:[longTags.length-255],body:longTags.subarray(255)}),
    oggPage({sequence:3,flags:4,packets:[Buffer.from([0,1])]}),
  ]);
  assert.equal(await inspect(t,continued),'ogg');
  const missingContinuation=Buffer.concat([
    oggPage({flags:2,packets:[opus[0]]}),
    oggPage({sequence:1,laces:[255],body:longTags.subarray(0,255)}),
    oggPage({sequence:2,flags:0,laces:[longTags.length-255],body:longTags.subarray(255)}),
  ]);
  assert.equal(await inspect(t,missingContinuation),undefined);
});

test('Ogg page work is bounded by input bytes without a million-page cutoff',()=>{
  assert.equal(maxOggPagesForBytes(27*1_000_001),1_000_001);
  assert.equal(maxOggPagesForBytes(26),0);
});


test('container scanning preserves cancellation instead of reporting unsupported input',async t=>{
  const {ogg}=await import('./audio-fixtures.mjs');
  const cancelled=new Error('cancelled');
  let checks=0;
  await assert.rejects(inspect(t,ogg(),()=>{if(++checks>3)throw cancelled;}),error=>error===cancelled);
});

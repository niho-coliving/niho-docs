import { inspectAdts, inspectFlac, inspectOgg } from './audio-containers.mjs';

// Container inspection only: never decode unknown input. Return undefined on
// truncated/ambiguous input. M4A requires an explicit audio brand and audio-only
// handlers, since ISO BMFF video shares the same `ftyp` signature.
export async function audioFormat(file, size, assertActive = () => {}) {
  const bytes = async (at, length) => {
    assertActive();
    if (at < 0 || length < 0 || at + length > size) throw new Error('format');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, at);
    if (bytesRead !== length) throw new Error('format');
    return buffer;
  };
  const ascii = (buffer, start, end) => buffer.toString('ascii', start, end);
  try {
    const head = await bytes(0, Math.min(size, 16));
    if (head.length < 4) return;
    if (ascii(head,0,4) === 'fLaC') return await inspectFlac(bytes,size) ? 'flac' : undefined;
    if (ascii(head,0,4) === 'OggS') return await inspectOgg(bytes,size) ? 'ogg' : undefined;
    if (ascii(head,0,4) === 'RIFF' && ascii(head,8,12) === 'WAVE') return 'wav';
    if (ascii(head,0,4) === 'FORM' && ascii(head,8,12) === 'AIFC') return 'aifc';
    if (ascii(head,0,4) === 'caff' && head.readUInt16BE(4) === 1 && head.readUInt16BE(6) === 0) return 'caf';
    let mp3At = 0;
    if (ascii(head,0,3) === 'ID3') {
      if (head.length < 10) return;
      if (![2,3,4].includes(head[3]) || head[4] === 255 || [...head.subarray(6,10)].some(n => n > 127)) return;
      mp3At = 10 + head[6] * 2097152 + head[7] * 16384 + head[8] * 128 + head[9];
      if (head[3] === 4 && (head[5] & 0x10)) mp3At += 10;
      if (mp3At > 16 * 1024 ** 2) return;
    }
    const frame = mp3At ? await bytes(mp3At,4) : head;
    if (frame[0] === 255 && (frame[1]&0xf6) === 0xf0) return await inspectAdts(bytes,size,mp3At) ? 'aac' : undefined;
    if (frame[0] === 255 && (frame[1]&224) === 224 && (frame[1]&24) !== 8 && (frame[1]&6) === 2 && (frame[2]&240) !== 0 && (frame[2]&240) !== 240 && (frame[2]&12) !== 12) return 'mp3';
    if (ascii(head,4,8) !== 'ftyp' || ascii(head,8,12) !== 'M4A ') return;
    let count = 0;
    let audioTracks = 0;
    let movie = false;
    const scan = async (start, end, kind) => {
      let handlers = 0;
      for (let at=start;at<end;) {
        if (++count > 10000 || end-at<8) throw new Error('format');
        const h=await bytes(at,8);
        let length=h.readUInt32BE(0);
        let header=8;
        if (length === 1) {
          const extended=(await bytes(at+8,8)).readBigUInt64BE();
          if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('format');
          length=Number(extended); header=16;
        } else if (length === 0) length=end-at;
        if (length<header || at+length>end) throw new Error('format');
        const type=ascii(h,4,8);
        if (kind === 'top' && type === 'moov') { if(movie) throw new Error('format'); movie=true; await scan(at+header,at+length,'moov'); }
        if (kind === 'moov' && type === 'trak') { await scan(at+header,at+length,'trak'); audioTracks++; }
        if (kind === 'trak' && type === 'mdia') { await scan(at+header,at+length,'mdia'); handlers++; }
        if (kind === 'mdia' && type === 'hdlr') {
          const handler=await bytes(at+header,12);
          if (ascii(handler,8,12) !== 'soun') throw new Error('format');
          handlers++;
        }
        at+=length;
      }
      if (['trak','mdia'].includes(kind) && handlers !== 1) throw new Error('format');
    };
    await scan(0,size,'top');
    return movie && audioTracks > 0 ? 'm4a' : undefined;
  } catch { assertActive(); return undefined; }
}

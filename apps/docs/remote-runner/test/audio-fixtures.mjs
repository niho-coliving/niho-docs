// Small structural fixtures: no external encoder or actual audio decoding.
export function adts({crc=false,payload=Buffer.alloc(8),sampleIndex=4,channels=1}={}) {
  const header=Buffer.alloc(crc?9:7);
  const length=header.length+payload.length;
  header[0]=255; header[1]=crc?240:241;
  header[2]=64|(sampleIndex<<2)|(channels>>2);
  header[3]=((channels&3)<<6)|(length>>11);
  header[4]=(length>>3)&255;
  header[5]=((length&7)<<5)|31;
  header[6]=252;
  return Buffer.concat([header,payload]);
}
export function flac() {
  const info=Buffer.alloc(34);
  info.writeUInt16BE(4096,0); info.writeUInt16BE(4096,2);
  info.writeBigUInt64BE((44100n<<44n)|(15n<<36n)|44100n,10);
  return Buffer.concat([Buffer.from('fLaC'),Buffer.from([128,0,0,34]),info,Buffer.from([255,248,105,8,0,0,0,0])]);
}
export function oggPage({serial=7,sequence=0,flags=0,packets=[],laces,body}={}) {
  if(!laces) {
    laces=[];
    for(const packet of packets) {
      let left=packet.length;
      while(left>=255) { laces.push(255); left-=255; }
      laces.push(left);
    }
    body=Buffer.concat(packets);
  }
  const header=Buffer.alloc(27);
  header.write('OggS',0); header[5]=flags;
  header.writeUInt32LE(serial,14); header.writeUInt32LE(sequence,18); header[26]=laces.length;
  const page=Buffer.concat([header,Buffer.from(laces),body]);
  // Bitwise reference implementation, independent of production's lookup table.
  let crc=0;
  for(const byte of page) {
    crc^=byte<<24;
    for(let bit=0;bit<8;bit++) crc=(crc&0x80000000)?(crc<<1)^0x04c11db7:crc<<1;
  }
  page.writeUInt32LE(crc>>>0,22);
  return page;
}
export function vorbisHeaders() {
  const id=Buffer.alloc(30);
  id[0]=1; id.write('vorbis',1); id[11]=1; id.writeUInt32LE(44100,12); id[28]=0xb8; id[29]=1;
  const comments=Buffer.alloc(20);
  comments[0]=3; comments.write('vorbis',1); comments.writeUInt32LE(4,7); comments.write('NIHO',11); comments[19]=1;
  return [id,comments,Buffer.from([5,...Buffer.from('vorbis'),1])];
}
export function opusHeaders() {
  const id=Buffer.alloc(19);
  id.write('OpusHead'); id[8]=1; id[9]=1; id.writeUInt32LE(48000,12);
  const tags=Buffer.alloc(20); tags.write('OpusTags'); tags.writeUInt32LE(4,8); tags.write('NIHO',12);
  return [id,tags];
}
export function ogg(codec='vorbis',serial=7) {
  const headers=codec==='vorbis'?vorbisHeaders():opusHeaders();
  return Buffer.concat([
    oggPage({serial,flags:2,packets:[headers[0]]}),
    oggPage({serial,sequence:1,packets:headers.slice(1)}),
    oggPage({serial,sequence:2,flags:4,packets:[Buffer.from([0,1,2])]}),
  ]);
}

// Container checks, not a second audio decoder. Actual frame decoding and the
// six-hour duration limit remain niho-speech's responsibility.
const requireFormat = (ok) => { if (!ok) throw new Error('format'); };
const ascii = (buffer,start,end) => buffer.toString('ascii',start,end);

export async function inspectAdts(bytes,size,start=0) {
  let at=start,frames=0,configuration;
  let cachedAt=-1,cached=Buffer.alloc(0);
  const header = async (position) => {
    if (position < cachedAt || position+7 > cachedAt+cached.length) {
      cachedAt=position;
      cached=await bytes(position,Math.min(64*1024,size-position));
    }
    requireFormat(position+7 <= cachedAt+cached.length);
    return cached.subarray(position-cachedAt,position-cachedAt+7);
  };
  while(at<size) {
    const h=await header(at);
    requireFormat(++frames<=2100000 && h[0]===255 && (h[1]&0xf6)===0xf0);
    const sampleRate=(h[2]>>2)&15;
    const channels=((h[2]&1)<<2)|(h[3]>>6);
    const frameBytes=((h[3]&3)<<11)|(h[4]<<3)|(h[5]>>5);
    const headerBytes=(h[1]&1)?7:9;
    requireFormat(sampleRate<=12 && channels>0 && frameBytes>headerBytes && at+frameBytes<=size);
    const current=`${sampleRate}:${channels}`;
    requireFormat(configuration===undefined || configuration===current);
    configuration=current;
    at+=frameBytes;
  }
  return frames>0;
}

// RFC 9639 §8.2 / §9.1: STREAMINFO plus a plausible first audio frame.
export async function inspectFlac(bytes,size) {
  let at=4,blocks=0,last=false;
  while(!last) {
    const h=await bytes(at,4);
    const type=h[0]&127,length=h.readUIntBE(1,3);
    last=!!(h[0]&128);
    requireFormat(++blocks<=10000 && type<=6 && at+4+length<=size);
    if(blocks===1) {
      requireFormat(type===0 && length===34);
      const info=await bytes(at+4,34);
      const minimum=info.readUInt16BE(0),maximum=info.readUInt16BE(2);
      const rate=(info[10]<<12)|(info[11]<<4)|(info[12]>>4);
      const depth=(((info[12]&1)<<4)|(info[13]>>4))+1;
      requireFormat(minimum>=16 && maximum>=minimum && rate>0 && rate<=655350 && depth>=4 && depth<=32);
      const minFrame=info.readUIntBE(4,3),maxFrame=info.readUIntBE(7,3);
      requireFormat(!minFrame || !maxFrame || minFrame<=maxFrame);
    } else requireFormat(type!==0);
    at+=4+length;
  }
  const frame=await bytes(at,Math.min(8,size-at));
  requireFormat(frame.length>=8 && frame[0]===255 && (frame[1]&254)===248
    && (frame[2]>>4)!==0 && (frame[2]&15)!==15 && (frame[3]>>4)<=10
    && ((frame[3]>>1)&7)!==3 && (frame[3]&1)===0);
  return true;
}

// Xiph Ogg framing: direct CRC-32, polynomial 0x04c11db7, no initial/final XOR.
const crcTable=Uint32Array.from({length:256},(_,index)=>{
  let value=index<<24;
  for(let bit=0;bit<8;bit++) value=(value&0x80000000)?(value<<1)^0x04c11db7:value<<1;
  return value>>>0;
});
function pageCrc(page) {
  let crc=0;
  for(const value of page) crc=((crc<<8)^crcTable[((crc>>>24)^value)&255])>>>0;
  return crc;
}

function comments(packet,start,vorbis) {
  let at=start;
  const length=()=>{
    requireFormat(at+4<=packet.length);
    const value=packet.readUInt32LE(at); at+=4;
    return value;
  };
  const vendorLength=length();
  at+=vendorLength;
  requireFormat(at<=packet.length);
  const count=length();
  requireFormat(count<=Math.floor((packet.length-at)/4));
  for(let i=0;i<count;i++) { const entryLength=length(); at+=entryLength; requireFormat(at<=packet.length); }
  if(vorbis) requireFormat(at+1===packet.length && packet[at]===1);
  // RFC 7845 permits trailing padding/binary metadata in OpusTags.
}

function identify(packet) {
  if(packet.length===30 && packet[0]===1 && ascii(packet,1,7)==='vorbis') {
    requireFormat(packet.readUInt32LE(7)===0 && packet[11]>0 && packet.readUInt32LE(12)>0
      && (packet[28]&15)>=6 && (packet[28]&15)<=13 && (packet[28]>>4)>=(packet[28]&15)
      && (packet[28]>>4)<=13 && packet[29]===1);
    return 'vorbis';
  }
  if(packet.length>=19 && ascii(packet,0,8)==='OpusHead') {
    const channels=packet[9],family=packet[18];
    requireFormat(packet[8]===1 && channels>0);
    if(family===0) requireFormat(channels<=2 && packet.length===19);
    else {
      requireFormat(family===1 && channels<=8 && packet.length===21+channels);
      const streams=packet[19],coupled=packet[20];
      requireFormat(streams>0 && coupled<=streams && streams+coupled<=255);
      for(const mapped of packet.subarray(21)) requireFormat(mapped===255 || mapped<streams+coupled);
    }
    return 'opus';
  }
  throw new Error('format'); // Theora, Skeleton and unknown logical streams fail closed.
}

function consumeHeader(state,packet) {
  if(state.headers===0) state.codec=identify(packet);
  else if(state.codec==='vorbis') {
    requireFormat(packet.length>=7 && packet[0]===(state.headers===1?3:5) && ascii(packet,1,7)==='vorbis');
    if(state.headers===1) comments(packet,7,true);
    else requireFormat(packet.length>7);
  } else {
    requireFormat(packet.length>=16 && ascii(packet,0,8)==='OpusTags');
    comments(packet,8,false);
  }
  state.headers++;
}

// Scan every logical stream/page, bounded by the input size. Never classify an
// Ogg from its first page alone: later multiplexed/chained video must be refused.
export function maxOggPagesForBytes(size) {
  return Math.floor(size / 27);
}

export async function inspectOgg(bytes,size) {
  let at=0;
  // Every page consumes at least its 27-byte header, so the input byte ceiling
  // bounds work without rejecting valid long streams based on packet layout.
  const maxPages=maxOggPagesForBytes(size);
  let pages=0;
  const streams=new Map();
  while(at<size) {
    requireFormat(++pages<=maxPages);
    const h=await bytes(at,27);
    requireFormat(ascii(h,0,4)==='OggS' && h[4]===0 && (h[5]&248)===0);
    const flags=h[5],serial=h.readUInt32LE(14),sequence=h.readUInt32LE(18);
    let state=streams.get(serial);
    if(!state) {
      requireFormat(streams.size<32 && !!(flags&2) && !(flags&1) && sequence===0);
      state={sequence:0,headers:0,codec:undefined,packetBytes:0,parts:[],audioPackets:0,eos:false};
      streams.set(serial,state);
    } else requireFormat(!(flags&2) && !state.eos && sequence===state.sequence);
    requireFormat(!!(flags&1)===(state.packetBytes>0));
    const laces=await bytes(at+27,h[26]);
    const bodySize=laces.reduce((sum,n)=>sum+n,0);
    const body=await bytes(at+27+laces.length,bodySize);
    const page=Buffer.concat([h,laces,body]);
    const expected=page.readUInt32LE(22); page.writeUInt32LE(0,22);
    requireFormat(pageCrc(page)===expected);
    let offset=0;
    for(const length of laces) {
      const headerCount=state.codec==='vorbis'?3:2;
      const isHeader=state.headers<headerCount;
      state.packetBytes+=length;
      if(isHeader) {
        requireFormat(state.packetBytes<=1024**2);
        state.parts.push(body.subarray(offset,offset+length));
      }
      offset+=length;
      if(length<255) {
        if(isHeader) consumeHeader(state,Buffer.concat(state.parts,state.packetBytes));
        else { requireFormat(state.packetBytes>0); state.audioPackets++; }
        state.packetBytes=0;
        state.parts=[];
      }
    }
    if(flags&2) requireFormat(state.headers===1 && state.packetBytes===0);
    if(flags&4) {
      requireFormat(state.packetBytes===0 && state.headers===(state.codec==='vorbis'?3:2) && state.audioPackets>0);
      state.eos=true;
    }
    state.sequence=(sequence+1)>>>0;
    at+=page.length;
  }
  requireFormat(streams.size>0 && [...streams.values()].every(state=>state.eos));
  return true;
}

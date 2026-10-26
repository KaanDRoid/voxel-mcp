import fs from 'node:fs';
export const MAX_FILE_VOXELS = 4_000_000;
export type Voxel = { x: number; y: number; z: number; i: number };
export interface VoxModelData {
  sizeX: number; sizeY: number; sizeZ: number; voxels: Voxel[];
  /** Indexed by voxel index; little-endian RGBA (ABGR uint32). Index zero is unused. */
  palette?: Uint32Array;
}
export interface VoxChunk { id: string; content: Buffer; children: VoxChunk[] }
export interface VoxDocument { version: number; main: VoxChunk }
/** Options shared by the VOX parsers. Strict mode (the default) rejects anything malformed. */
export interface ParseOptions {
  /** Recover from duplicate voxels, duplicate dictionary keys, invalid UTF-8 and malformed non-critical chunks. */
  lenient?: boolean;
  /** Receives one message per recovered problem when `lenient` is set. */
  warnings?: string[];
}
export function validateModel(m: VoxModelData): void {
  for (const n of [m.sizeX,m.sizeY,m.sizeZ]) if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('VOX dimensions must be integers in 1..256');
  if (m.palette && m.palette.length !== 256) throw new Error('VOX palette must contain 256 entries');
  if (m.voxels.length > m.sizeX*m.sizeY*m.sizeZ) throw new Error('Voxel count exceeds model volume');
  if (!m.voxels.length) return;
  const occupied = new Uint8Array(m.sizeX * m.sizeY * m.sizeZ);
  for (const v of m.voxels) {
    for (const [n,size] of [[v.x,m.sizeX],[v.y,m.sizeY],[v.z,m.sizeZ]] as const) if (!Number.isInteger(n) || n < 0 || n >= size) throw new Error('Voxel coordinate outside model');
    if (!Number.isInteger(v.i) || v.i < 1 || v.i > 255) throw new Error('Voxel palette index must be in 1..255');
    const key = v.x + m.sizeX * (v.y + m.sizeY * v.z);
    if (occupied[key]) throw new Error('Duplicate voxel coordinate');
    occupied[key] = 1;
  }
}
export function decodeVOXDocument(buf: Buffer): VoxDocument {
  if (buf.length < 20 || buf.toString('ascii',0,4) !== 'VOX ') throw new Error('Not a complete VOX file');
  const version = buf.readUInt32LE(4);
  if (version !== 150 && version !== 200) throw new Error(`Unsupported VOX version ${version}`);
  function read(off: number, end: number, depth: number): [VoxChunk, number] {
    if (depth > 128 || off+12 > end) throw new Error('Truncated or excessively nested VOX chunk');
    const id=buf.toString('latin1',off,off+4), length=buf.readUInt32LE(off+4), childLength=buf.readUInt32LE(off+8);
    const start=off+12, contentEnd=start+length, chunkEnd=contentEnd+childLength;
    if (chunkEnd > end) throw new Error(`Truncated ${id} chunk`);
    const children: VoxChunk[]=[];
    let pos=contentEnd;
    while(pos<chunkEnd) { const [c,next]=read(pos,chunkEnd,depth+1); children.push(c); pos=next; }
    return [{id,content:Buffer.from(buf.subarray(start,contentEnd)),children},chunkEnd];
  }
  const [main,end]=read(8,buf.length,0);
  if(main.id!=='MAIN' || main.content.length!==0 || end!==buf.length) throw new Error('Invalid MAIN chunk or trailing bytes');
  return {version,main};
}
export function encodeVOXDocument(doc: VoxDocument): Buffer {
  if (![150,200].includes(doc.version) || doc.main.id!=='MAIN' || doc.main.content.length) throw new Error('Invalid VOX document');
  function write(c: VoxChunk, depth: number): Buffer {
    if(depth>128 || c.id.length!==4) throw new Error('Invalid chunk');
    const children=c.children.map(x=>write(x,depth+1)), h=Buffer.alloc(12);
    h.write(c.id,0,4,'latin1'); h.writeUInt32LE(c.content.length,4); h.writeUInt32LE(children.reduce((n,b)=>n+b.length,0),8);
    return Buffer.concat([h,c.content,...children]);
  }
  const h=Buffer.alloc(8); h.write('VOX '); h.writeUInt32LE(doc.version,4);
  return Buffer.concat([h,write(doc.main,0)]);
}
export function modelChunks(m: VoxModelData): VoxChunk[] {
  validateModel(m);
  const size=Buffer.alloc(12); [m.sizeX,m.sizeY,m.sizeZ].forEach((n,i)=>size.writeUInt32LE(n,i*4));
  const data=Buffer.alloc(4+m.voxels.length*4); data.writeUInt32LE(m.voxels.length);
  m.voxels.forEach((v,i)=> { data[4+i*4]=v.x; data[5+i*4]=v.y; data[6+i*4]=v.z; data[7+i*4]=v.i; });
  return [{id:'SIZE',content:size,children:[]},{id:'XYZI',content:data,children:[]}];
}
/** Lenient recovery: when several voxels share a cell the last one wins (bounds are still validated afterwards). */
function dedupeVoxels(m: VoxModelData, warnings?: string[]): void {
  const slot=new Map<number,number>(); const kept: Voxel[]=[]; let dropped=0;
  for(const v of m.voxels) {
    if(v.x>=m.sizeX||v.y>=m.sizeY||v.z>=m.sizeZ) { kept.push(v); continue; }
    const key=v.x+m.sizeX*(v.y+m.sizeY*v.z), at=slot.get(key);
    if(at===undefined) { slot.set(key,kept.length); kept.push(v); } else { kept[at]=v; dropped++; }
  }
  if(dropped) { warnings?.push(`Dropped ${dropped} duplicate voxel(s); the last one wins`); m.voxels=kept; }
}
export function readDocumentModels(doc: VoxDocument, options: ParseOptions = {}): VoxModelData[] {
  const models: VoxModelData[]=[]; let pending: VoxModelData | undefined; let pack: number | undefined; let palette: Uint32Array | undefined;
  for(const c of doc.main.children) {
    if(['SIZE','XYZI','PACK','RGBA'].includes(c.id) && c.children.length) throw new Error(`${c.id} cannot have children`);
    if(c.id==='SIZE') {
      if(pending || c.content.length!==12) throw new Error('Invalid SIZE pairing or length');
      pending={sizeX:c.content.readUInt32LE(0),sizeY:c.content.readUInt32LE(4),sizeZ:c.content.readUInt32LE(8),voxels:[]}; validateModel(pending);
    } else if(c.id==='XYZI') {
      if(!pending || c.content.length<4) throw new Error('XYZI without SIZE');
      const n=c.content.readUInt32LE(0); if(c.content.length!==4+n*4) throw new Error('Invalid XYZI count'); if(n>MAX_FILE_VOXELS) throw new Error('XYZI voxel count exceeds the supported limit');
      for(let i=0;i<n;i++) { const p=4+i*4; pending.voxels.push({x:c.content[p]!,y:c.content[p+1]!,z:c.content[p+2]!,i:c.content[p+3]!}); }
      if(options.lenient) dedupeVoxels(pending,options.warnings);
      validateModel(pending); models.push(pending); pending=undefined;
    } else if(c.id==='PACK') {
      if(pack!==undefined || c.content.length!==4) throw new Error('Invalid PACK'); pack=c.content.readUInt32LE(0);
    } else if(c.id==='RGBA') {
      if(palette || c.content.length!==1024) throw new Error('Invalid RGBA');
      palette=new Uint32Array(256); for(let i=1;i<256;i++) palette[i]=c.content.readUInt32LE((i-1)*4);
    }
  }
  if(pending || !models.length || (pack!==undefined && pack!==models.length)) throw new Error('Missing model or mismatched PACK count');
  if(palette) for(const m of models) m.palette=new Uint32Array(palette);
  return models;
}
export function encodeVOX(m: VoxModelData): Buffer {
  const children=modelChunks(m);
  if(m.palette) { const content=Buffer.alloc(1024); for(let i=1;i<256;i++) content.writeUInt32LE(m.palette[i]!, (i-1)*4); children.push({id:'RGBA',content,children:[]}); }
  return encodeVOXDocument({version:150,main:{id:'MAIN',content:Buffer.alloc(0),children}});
}
export function saveVOX(path: string, m: VoxModelData): void { fs.writeFileSync(path,encodeVOX(m)); }
/** Loads one model. Files with several models need an explicit `modelIndex` (or a scene/multi-model loader). */
export function loadVOX(path: string, modelIndex?: number, options: ParseOptions = {}): VoxModelData {
  const models=readDocumentModels(decodeVOXDocument(fs.readFileSync(path)),options);
  if(modelIndex!==undefined) {
    const picked=models[modelIndex];
    if(!Number.isInteger(modelIndex)||!picked) throw new Error(`modelIndex ${modelIndex} is out of range; the file contains ${models.length} model(s)`);
    return picked;
  }
  if(models.length!==1) throw new Error(`VOX contains multiple models (${models.length}); pass modelIndex to load one of them, or use load_vox_models / load_scene to keep them all (no silent selection)`);
  return models[0]!;
}
export function defaultPalette(): Uint32Array {
  const pal=new Uint32Array(256);
  let i=1;
  for(const r of [255,204,153,102,51,0]) for(const g of [255,204,153,102,51,0]) for(const b of [255,204,153,102,51,0]) {
    if(r || g || b) pal[i++]=(0xff000000 | (b<<16) | (g<<8) | r)>>>0;
  }
  for(const channel of [0,8,16,24]) for(const v of [238,221,187,170,136,119,85,68,34,17]) {
    pal[i++]=(0xff000000 | (channel===24 ? v*0x010101 : v<<channel))>>>0;
  }
  return pal;
}


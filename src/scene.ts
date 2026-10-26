import fs from 'node:fs';
import { decodeVOXDocument, encodeVOXDocument, modelChunks, readDocumentModels, defaultPalette } from './vox.js';
import type { VoxDocument, VoxModelData, VoxChunk } from './vox.js';

export type VoxDictionary = Record<string,string>;
export type SceneNode =
  | {type:'nTRN'; id:number; attributes:VoxDictionary; childId:number; layerId:number; frames:VoxDictionary[]}
  | {type:'nGRP'; id:number; attributes:VoxDictionary; children:number[]}
  | {type:'nSHP'; id:number; attributes:VoxDictionary; models:{modelId:number; attributes:VoxDictionary}[]};
export interface SceneMetadata { id:number; attributes:VoxDictionary }
export interface VoxScene { document: VoxDocument; models: VoxModelData[]; nodes:SceneNode[]; layers:SceneMetadata[]; materials:SceneMetadata[] }
const originals=new WeakMap<object,{json:string; chunk:VoxChunk}>();
function parseMetadata(c:VoxChunk): SceneNode | SceneMetadata {
  let p=0;
  const int=()=> { if(p+4>c.content.length) throw new Error('Truncated scene metadata'); const n=c.content.readInt32LE(p); p+=4; return n; };
  const count=(min=0)=> { const n=int(); if(n<min || n>(c.content.length-p)/4) throw new Error('Invalid scene metadata count'); return n; };
  const string=()=> { const n=int(); if(n<0 || p+n>c.content.length) throw new Error('Truncated dictionary string'); const s=new TextDecoder('utf-8',{fatal:true}).decode(c.content.subarray(p,p+n)); p+=n; return s; };
  const dict=()=> { const n=count(); const d:VoxDictionary=Object.create(null); for(let i=0;i<n;i++) {const k=string(); if(Object.hasOwn(d,k)) throw new Error('Duplicate dictionary key'); d[k]=string();} return d; };
  const id=int(), attributes=dict();
  let result:SceneNode | SceneMetadata;
  if(c.id==='nTRN') {const childId=int(); if(int()!==-1) throw new Error('Invalid transform reserved id'); const layerId=int(), n=count(1), frames=Array.from({length:n},dict); result={type:'nTRN',id,attributes,childId,layerId,frames};}
  else if(c.id==='nGRP') result={type:'nGRP',id,attributes,children:Array.from({length:count()},int)};
  else if(c.id==='nSHP') result={type:'nSHP',id,attributes,models:Array.from({length:count(1)},()=>({modelId:int(),attributes:dict()}))};
  else {if(c.id==='LAYR' && int()!==-1) throw new Error('Invalid layer reserved id'); result={id,attributes};}
  if(p!==c.content.length || c.children.length) throw new Error('Invalid scene metadata length');
  originals.set(result,{json:JSON.stringify(result),chunk:c}); return result;
}
function metadataChunk(type:string, value:SceneNode | SceneMetadata):VoxChunk {
  const original=originals.get(value); if(original?.json===JSON.stringify(value)) return original.chunk;
  const parts:Buffer[]=[];
  const int=(n:number)=> {if(!Number.isInteger(n)||n < -2147483648||n>2147483647) throw new Error('Invalid metadata integer'); const b=Buffer.alloc(4); b.writeInt32LE(n); parts.push(b);};
  const dict=(d:VoxDictionary)=> {int(Object.keys(d).length); for(const [k,v] of Object.entries(d)) for(const s of [k,v]) {if(typeof s!=='string') throw new Error('Dictionary values must be strings'); const b=Buffer.from(s,'utf8'); int(b.length); parts.push(b);}};
  int(value.id); dict(value.attributes);
  if('type' in value) {
    if(value.type==='nTRN') {int(value.childId); int(-1); int(value.layerId); int(value.frames.length); value.frames.forEach(dict);}
    else if(value.type==='nGRP') {int(value.children.length); value.children.forEach(int);}
    else {int(value.models.length); for(const m of value.models) {int(m.modelId); dict(m.attributes);}}
  } else if(type==='LAYR') int(-1);
  return {id:type,content:Buffer.concat(parts),children:[]};
}
function validateGraph(scene:VoxScene):void {
  const nodes=new Map<number,SceneNode>();
  for(const n of scene.nodes) {if(!Number.isInteger(n.id)||n.id<0||nodes.has(n.id)) throw new Error('Invalid or duplicate node id'); nodes.set(n.id,n);}
  for(const values of [scene.layers,scene.materials]) {const ids=new Set<number>(); for(const v of values) {if(!Number.isInteger(v.id)||v.id<0||ids.has(v.id)) throw new Error('Invalid or duplicate metadata id'); ids.add(v.id);}}
  const edges=(n:SceneNode)=>n.type==='nTRN'?[n.childId]:n.type==='nGRP'?n.children:[];
  for(const n of scene.nodes) {
    for(const child of edges(n)) if(!nodes.has(child)) throw new Error('Missing scene node reference');
    if(n.type==='nSHP') {if(!n.models.length) throw new Error('Shape requires models'); for(const m of n.models) if(!Number.isInteger(m.modelId)||m.modelId<0||m.modelId>=scene.models.length) throw new Error('Missing scene model reference');}
    if(n.type==='nTRN') {if(!n.frames.length) throw new Error('Transform requires frames'); if(n.layerId!==-1&&!scene.layers.some(l=>l.id===n.layerId)) throw new Error('Missing scene layer reference'); for(const f of n.frames) {if(f._t!==undefined) parseTranslation(f._t); if(f._r!==undefined) validateRotation(Number(f._r));}}
  }
  const visiting=new Set<number>(), done=new Set<number>();
  function visit(id:number,depth:number) {if(visiting.has(id)||depth>1024) throw new Error('Cyclic or excessively deep scene graph'); if(done.has(id)) return; visiting.add(id); for(const child of edges(nodes.get(id)!)) visit(child,depth+1); visiting.delete(id); done.add(id);}
  for(const id of nodes.keys()) visit(id,0);
}
function validateRotation(r:number):void {if(!Number.isInteger(r)||r<0||r>127||(r&3)>2||((r>>2)&3)>2||(r&3)===((r>>2)&3)) throw new Error('Invalid packed rotation');}
function parseTranslation(t:string):[number,number,number] {const parts=t.trim().split(/\s+/); const v=parts.map(Number); if(parts.length!==3||parts.some(s=>!/^[-+]?\d+$/.test(s))||v.some(n=>!Number.isInteger(n)||n< -2147483648||n>2147483647)) throw new Error('Invalid translation'); return v as [number,number,number];}
export function listScene(scene:VoxScene) {return {models:scene.models.map((m,id)=>({id,size:[m.sizeX,m.sizeY,m.sizeZ],voxelCount:m.voxels.length})),nodes:scene.nodes,layers:scene.layers,materials:scene.materials};}
export function setSceneNodeAttributes(scene:VoxScene,nodeId:number,attributes:VoxDictionary):void {const node=scene.nodes.find(n=>n.id===nodeId); if(!node) throw new Error('Scene node not found'); node.attributes={...node.attributes,...attributes};}
export function setSceneTransform(scene:VoxScene,nodeId:number,translation:[number,number,number],rotation?:number,frame=0):void {
  const node=scene.nodes.find(n=>n.id===nodeId); if(node?.type!=='nTRN') throw new Error('Node is not a transform');
  if(!Number.isInteger(frame)||frame<0||frame>=node.frames.length) throw new Error('Frame not found');
  if(translation.length!==3) throw new Error('Translation requires three integers'); parseTranslation(translation.join(' ')); if(rotation!==undefined) validateRotation(rotation);
  node.frames[frame]={...node.frames[frame],_t:translation.join(' '),...(rotation===undefined?{}:{_r:String(rotation)})};
}
export function decodeVOXScene(bytes: Buffer): VoxScene {
  const document=decodeVOXDocument(bytes);
  const scene:VoxScene={document,models:readDocumentModels(document),nodes:[],layers:[],materials:[]};
  for(const c of document.main.children) {
    if(['nTRN','nGRP','nSHP'].includes(c.id)) scene.nodes.push(parseMetadata(c) as SceneNode);
    else if(c.id==='LAYR') scene.layers.push(parseMetadata(c));
    else if(c.id==='MATL') scene.materials.push(parseMetadata(c));
  }
  validateGraph(scene); return scene;
}
export function createVOXScene(models: VoxModelData[]): VoxScene {
  const scene:VoxScene={document:{version:150,main:{id:'MAIN',content:Buffer.alloc(0),children:[]}},models:models.map(m=>({...m,voxels:m.voxels.map(v=>({...v})),...(m.palette?{palette:new Uint32Array(m.palette)}:{})})),nodes:[],layers:[],materials:[]};
  encodeVOXScene(scene); return scene;
}
export function encodeVOXScene(scene: VoxScene): Buffer {
  if(!scene.models.length) throw new Error('Scene must contain a model');
  validateGraph(scene);
  const replacements=scene.models.flatMap(modelChunks);
  const palette=scene.models[0]!.palette??defaultPalette();
  for(const model of scene.models) {const other=model.palette??defaultPalette(); if(other.some((v,i)=>i>0&&v!==palette[i])) throw new Error('Scene models must share the same palette');}
  const originalRGBA=scene.document.main.children.find(c=>c.id==='RGBA');
  const rgba=originalRGBA?Buffer.from(originalRGBA.content):Buffer.alloc(1024);
  for(let i=1;i<256;i++) rgba.writeUInt32LE(palette[i]!, (i-1)*4);
  const writePalette=!!originalRGBA||scene.models.some(m=>m.palette!==undefined);
  const metadata=[...scene.nodes.map(n=>metadataChunk(n.type,n)),...scene.layers.map(n=>metadataChunk('LAYR',n)),...scene.materials.map(n=>metadataChunk('MATL',n))];
  const used=new Set<VoxChunk>();
  let next=0;
  const children: VoxChunk[]=[];
  for(const c of scene.document.main.children) {
    if(c.id==='SIZE' || c.id==='XYZI') { const replacement=replacements[next++]; if(replacement) children.push(replacement); }
    else if(c.id==='RGBA') {if(writePalette) children.push({...c,content:rgba});}
    else if(c.id==='PACK') { const content=Buffer.alloc(4); content.writeUInt32LE(scene.models.length); children.push({...c,content}); }
    else if(['nTRN','nGRP','nSHP','LAYR','MATL'].includes(c.id)) {
      const replacement=metadata.find(m=>!used.has(m)&&m.id===c.id&&m.content.readInt32LE(0)===c.content.readInt32LE(0));
      if(replacement) {children.push(replacement); used.add(replacement);}
    } else children.push(c);
  }
  children.push(...replacements.slice(next),...metadata.filter(m=>!used.has(m)));
  if(writePalette&&!originalRGBA) children.push({id:'RGBA',content:rgba,children:[]});
  if(scene.models.length>1&&scene.document.main.children.length===0&&!children.some(c=>c.id==='PACK')) {const content=Buffer.alloc(4); content.writeUInt32LE(scene.models.length); children.unshift({id:'PACK',content,children:[]});}
  const doc={version:scene.document.version,main:{...scene.document.main,children}};
  readDocumentModels(doc);
  return encodeVOXDocument(doc);
}
export function loadVOXScene(path: string): VoxScene { return decodeVOXScene(fs.readFileSync(path)); }
export function saveVOXScene(path: string, scene: VoxScene): void { fs.writeFileSync(path,encodeVOXScene(scene)); }

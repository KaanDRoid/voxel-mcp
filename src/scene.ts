import fs from 'node:fs';
import { decodeVOXDocument, encodeVOXDocument, modelChunks, readDocumentModels, defaultPalette } from './vox.js';
import type { VoxDocument, VoxModelData, VoxChunk, ParseOptions } from './vox.js';
import { Writer, createReader, emptyDictionary, parseRenderSettings, buildRenderObject, buildRenderCamera, buildNote, buildIndexMap, buildMeta, RENDER_CHUNK_IDS } from './voxChunks.js';
import type { VoxDictionary, RenderSettings, ChunkReader } from './voxChunks.js';
import { isValidRotation } from './rotation.js';

export type { VoxDictionary } from './voxChunks.js';
export type SceneNode =
  | {type:'nTRN'; id:number; attributes:VoxDictionary; childId:number; layerId:number; frames:VoxDictionary[]}
  | {type:'nGRP'; id:number; attributes:VoxDictionary; children:number[]}
  | {type:'nSHP'; id:number; attributes:VoxDictionary; models:{modelId:number; attributes:VoxDictionary}[]};
export interface SceneMetadata { id:number; attributes:VoxDictionary }
export interface VoxScene {
  document: VoxDocument; models: VoxModelData[]; nodes:SceneNode[]; layers:SceneMetadata[]; materials:SceneMetadata[];
  /** Typed render/project chunks (rOBJ, rCAM, NOTE, IMAP, META). Unknown chunks stay untouched in `document`. */
  render: RenderSettings;
  /** Problems recovered from while decoding with `lenient: true`. */
  warnings?: string[];
}
export interface SceneIndex { nodes:Map<number,SceneNode>; layers:Map<number,SceneMetadata>; materials:Map<number,SceneMetadata> }

/** Remembers the decoded form of every element so unchanged elements are written back as their original chunk. */
const originals=new WeakMap<object,{json:string; chunk:VoxChunk}>();
/** Top-level render chunks that were parsed into `scene.render` (the others are passed through untouched). */
const renderOwned=new WeakMap<RenderSettings,Set<VoxChunk>>();

function parseMetadata(c:VoxChunk, options:ParseOptions): SceneNode | SceneMetadata {
  const r:ChunkReader=createReader(c.content,options);
  const id=r.int(), attributes=r.dict();
  let result:SceneNode | SceneMetadata;
  if(c.id==='nTRN') {const childId=r.int(); if(r.int()!==-1) throw new Error('Invalid transform reserved id'); const layerId=r.int(), n=r.count(); if(n<1) throw new Error('Invalid scene metadata count'); result={type:'nTRN',id,attributes,childId,layerId,frames:Array.from({length:n},()=>r.dict())};}
  else if(c.id==='nGRP') result={type:'nGRP',id,attributes,children:Array.from({length:r.count()},()=>r.int())};
  else if(c.id==='nSHP') {const n=r.count(); if(n<1) throw new Error('Invalid scene metadata count'); result={type:'nSHP',id,attributes,models:Array.from({length:n},()=>({modelId:r.int(),attributes:r.dict()}))};}
  else {if(c.id==='LAYR' && r.int()!==-1) throw new Error('Invalid layer reserved id'); result={id,attributes};}
  if(r.pos!==c.content.length || c.children.length) throw new Error('Invalid scene metadata length');
  originals.set(result,{json:JSON.stringify(result),chunk:c}); return result;
}
function metadataChunk(type:string, value:SceneNode | SceneMetadata):VoxChunk {
  const original=originals.get(value); if(original?.json===JSON.stringify(value)) return original.chunk;
  const w=new Writer().int(value.id).dict(value.attributes);
  if('type' in value) {
    if(value.type==='nTRN') {w.int(value.childId).int(-1).int(value.layerId).int(value.frames.length); value.frames.forEach(f=>w.dict(f));}
    else if(value.type==='nGRP') {w.int(value.children.length); value.children.forEach(n=>w.int(n));}
    else {w.int(value.models.length); for(const m of value.models) w.int(m.modelId).dict(m.attributes);}
  } else if(type==='LAYR') w.int(-1);
  return {id:type,content:w.build(),children:[]};
}

const MAX_ID=2147483647;
/** Builds id -> element maps in one pass. Throws on invalid or duplicate ids. */
export function indexScene(scene:VoxScene):SceneIndex {
  const nodes=new Map<number,SceneNode>(), layers=new Map<number,SceneMetadata>(), materials=new Map<number,SceneMetadata>();
  for(const n of scene.nodes) {if(!Number.isInteger(n.id)||n.id<0||n.id>MAX_ID||nodes.has(n.id)) throw new Error('Invalid or duplicate node id'); nodes.set(n.id,n);}
  for(const [values,map] of [[scene.layers,layers],[scene.materials,materials]] as const) for(const v of values) {if(!Number.isInteger(v.id)||v.id<0||v.id>MAX_ID||map.has(v.id)) throw new Error('Invalid or duplicate metadata id'); map.set(v.id,v);}
  return {nodes,layers,materials};
}
function validateGraph(scene:VoxScene, index=indexScene(scene)):void {
  const {nodes,layers}=index;
  const edges=(n:SceneNode)=>n.type==='nTRN'?[n.childId]:n.type==='nGRP'?n.children:[];
  for(const n of scene.nodes) {
    for(const child of edges(n)) if(!nodes.has(child)) throw new Error('Missing scene node reference');
    if(n.type==='nSHP') {if(!n.models.length) throw new Error('Shape requires models'); for(const m of n.models) if(!Number.isInteger(m.modelId)||m.modelId<0||m.modelId>=scene.models.length) throw new Error('Missing scene model reference');}
    if(n.type==='nTRN') {if(!n.frames.length) throw new Error('Transform requires frames'); if(n.layerId!==-1&&!layers.has(n.layerId)) throw new Error('Missing scene layer reference'); for(const f of n.frames) {if(f._t!==undefined) parseTranslation(f._t); if(f._r!==undefined) validateRotation(Number(f._r));}}
  }
  const visiting=new Set<number>(), done=new Set<number>();
  function visit(id:number,depth:number) {if(visiting.has(id)||depth>1024) throw new Error('Cyclic or excessively deep scene graph'); if(done.has(id)) return; visiting.add(id); for(const child of edges(nodes.get(id)!)) visit(child,depth+1); visiting.delete(id); done.add(id);}
  for(const id of nodes.keys()) visit(id,0);
}
function validateRotation(r:number):void {if(!isValidRotation(r)) throw new Error('Invalid packed rotation');}
export function parseTranslation(t:string):[number,number,number] {const parts=t.trim().split(/\s+/); const v=parts.map(Number); if(parts.length!==3||parts.some(s=>!/^[-+]?\d+$/.test(s))||v.some(n=>!Number.isInteger(n)||n< -2147483648||n>2147483647)) throw new Error('Invalid translation'); return v as [number,number,number];}

/** Formats a palette entry (little-endian RGBA uint32) as #rrggbbaa. */
export function formatColor(c:number):string {return '#'+[c&255,(c>>>8)&255,(c>>>16)&255,(c>>>24)&255].map(n=>n.toString(16).padStart(2,'0')).join('');}
/** Returns the first palette index (1..255) at which the palettes differ, or undefined when they match. */
export function paletteMismatch(a:Uint32Array,b:Uint32Array):{index:number; a:string; b:string}|undefined {
  for(let i=1;i<256;i++) if(a[i]!==b[i]) return {index:i,a:formatColor(a[i]!),b:formatColor(b[i]!)};
  return undefined;
}
/** The scene palette is the first model's palette; a model without one uses the default palette. */
export function scenePalette(scene:VoxScene):Uint32Array {return scene.models[0]?.palette??defaultPalette();}
function checkPalettes(scene:VoxScene):Uint32Array {
  const palette=scenePalette(scene);
  scene.models.forEach((model,i)=> {
    if(i===0) return;
    const diff=paletteMismatch(palette,model.palette??defaultPalette());
    if(diff) throw new Error(`Scene models must share the same palette: model ${i}${model.palette?'':' (no palette, default assumed)'} differs from model 0 at index ${diff.index} (${diff.b} vs ${diff.a})`);
  });
  return palette;
}
/** Cheap structural validation (graph, ids, references, palettes) without serializing voxel data. */
export function validateScene(scene:VoxScene, index?:SceneIndex):void {
  if(!scene.models.length) throw new Error('Scene must contain a model');
  validateGraph(scene,index); checkPalettes(scene);
}
/** Approximate serialized size, used for storage limits without encoding. */
export function estimateSceneBytes(scene:VoxScene):number {
  let n=64+scene.document.main.children.reduce((s,c)=>s+c.content.length+12,0);
  for(const m of scene.models) n+=44+m.voxels.length*4;
  return n;
}

export function listScene(scene:VoxScene) {
  const r=scene.render;
  const render={objects:r.objects.map(o=>o.type),cameras:r.cameras.length,notes:r.notes?.length??0,hasIndexMap:!!r.imap,...(r.meta?{meta:r.meta}:{})};
  return {models:scene.models.map((m,id)=>({id,size:[m.sizeX,m.sizeY,m.sizeZ],voxelCount:m.voxels.length})),nodes:scene.nodes,layers:scene.layers,materials:scene.materials,render,...(scene.warnings?.length?{warnings:scene.warnings}:{})};
}
export function setSceneNodeAttributes(scene:VoxScene,nodeId:number,attributes:VoxDictionary,index?:SceneIndex):void {const node=(index??indexScene(scene)).nodes.get(nodeId); if(!node) throw new Error('Scene node not found'); node.attributes={...node.attributes,...attributes};}
export function setSceneTransform(scene:VoxScene,nodeId:number,translation:[number,number,number],rotation?:number,frame=0,index?:SceneIndex):void {
  const node=(index??indexScene(scene)).nodes.get(nodeId); if(node?.type!=='nTRN') throw new Error('Node is not a transform');
  if(!Number.isInteger(frame)||frame<0||frame>=node.frames.length) throw new Error('Frame not found');
  if(translation.length!==3) throw new Error('Translation requires three integers'); parseTranslation(translation.join(' ')); if(rotation!==undefined) validateRotation(rotation);
  node.frames[frame]={...node.frames[frame],_t:translation.join(' '),...(rotation===undefined?{}:{_r:String(rotation)})};
}

function typedRender(document:VoxDocument, options:ParseOptions):RenderSettings {
  const {render,sources}=parseRenderSettings(document.main.children,options);
  const owned=new Set<VoxChunk>();
  for(const [element,chunk] of sources) {originals.set(element,{json:JSON.stringify(element),chunk}); owned.add(chunk);}
  renderOwned.set(render,owned);
  return render;
}
/** Decodes a scene. Strict by default; `lenient` recovers from non-critical problems and reports them in `scene.warnings`. */
export function decodeVOXScene(bytes: Buffer, options:ParseOptions={}): VoxScene {
  const warnings:string[]=options.warnings??[];
  const opts:ParseOptions={...(options.lenient?{lenient:true}:{}),warnings};
  const document=decodeVOXDocument(bytes);
  const scene:VoxScene={document,models:readDocumentModels(document,opts),nodes:[],layers:[],materials:[],render:{objects:[],cameras:[]}};
  for(const c of document.main.children) {
    if(c.id==='nTRN'||c.id==='nGRP'||c.id==='nSHP') scene.nodes.push(parseMetadata(c,opts) as SceneNode);
    else if(c.id==='LAYR') scene.layers.push(parseMetadata(c,opts));
    else if(c.id==='MATL') scene.materials.push(parseMetadata(c,opts));
  }
  scene.render=typedRender(document,opts);
  validateGraph(scene);
  if(options.lenient&&warnings.length) scene.warnings=warnings;
  return scene;
}
export function createVOXScene(models: VoxModelData[]): VoxScene {
  const scene:VoxScene={document:{version:150,main:{id:'MAIN',content:Buffer.alloc(0),children:[]}},models:models.map(m=>({...m,voxels:m.voxels.map(v=>({...v})),...(m.palette?{palette:new Uint32Array(m.palette)}:{})})),nodes:[],layers:[],materials:[],render:{objects:[],cameras:[]}};
  encodeVOXScene(scene); return scene;
}
/**
 * Copy-on-write snapshot: graph, metadata and render settings are copied (so edits can be discarded on failure),
 * voxel data is shared and must be replaced rather than mutated in place.
 */
export function cloneScene(scene:VoxScene):VoxScene {
  const keep=<T extends object>(from:T,to:T):T=> {const o=originals.get(from); if(o) originals.set(to,o); return to;};
  const dict=(d:VoxDictionary):VoxDictionary=>Object.assign(emptyDictionary(),d);
  const node=(n:SceneNode):SceneNode=> keep(n,n.type==='nTRN'?{...n,attributes:dict(n.attributes),frames:n.frames.map(dict)}:n.type==='nGRP'?{...n,attributes:dict(n.attributes),children:[...n.children]}:{...n,attributes:dict(n.attributes),models:n.models.map(m=>({modelId:m.modelId,attributes:dict(m.attributes)}))});
  const meta=(m:SceneMetadata):SceneMetadata=>keep(m,{id:m.id,attributes:dict(m.attributes)});
  const r=scene.render;
  const render:RenderSettings={objects:r.objects.map(o=>keep(o,{type:o.type,attributes:dict(o.attributes)})),cameras:r.cameras.map(c=>keep(c,{id:c.id,attributes:dict(c.attributes)}))};
  if(r.notes) render.notes=keep(r.notes,[...r.notes]);
  if(r.imap) render.imap=keep(r.imap,[...r.imap]);
  if(r.meta) render.meta=keep(r.meta,dict(r.meta));
  const owned=renderOwned.get(r); if(owned) renderOwned.set(render,owned);
  return {document:{version:scene.document.version,main:{...scene.document.main,children:[...scene.document.main.children]}},models:[...scene.models],nodes:scene.nodes.map(node),layers:scene.layers.map(meta),materials:scene.materials.map(meta),render,...(scene.warnings?{warnings:[...scene.warnings]}:{})};
}

/** Replacement chunks for typed render elements, keyed by the chunk they were decoded from. */
function renderChunks(render:RenderSettings):{replace:Map<VoxChunk,VoxChunk>; added:VoxChunk[]} {
  const replace=new Map<VoxChunk,VoxChunk>(), added:VoxChunk[]=[];
  const put=(element:object,build:()=>VoxChunk)=> {
    const o=originals.get(element);
    if(o&&o.json===JSON.stringify(element)) replace.set(o.chunk,o.chunk);
    else if(o) replace.set(o.chunk,build());
    else added.push(build());
  };
  for(const o of render.objects) put(o,()=>buildRenderObject(o));
  for(const c of render.cameras) put(c,()=>buildRenderCamera(c));
  if(render.notes) put(render.notes,()=>buildNote(render.notes!));
  if(render.imap) put(render.imap,()=>buildIndexMap(render.imap!));
  if(render.meta) put(render.meta,()=>buildMeta(render.meta!));
  return {replace,added};
}
export function encodeVOXScene(scene: VoxScene): Buffer {
  if(!scene.models.length) throw new Error('Scene must contain a model');
  validateGraph(scene);
  const replacements=scene.models.flatMap(modelChunks);
  const palette=checkPalettes(scene);
  const originalRGBA=scene.document.main.children.find(c=>c.id==='RGBA');
  const rgba=originalRGBA?Buffer.from(originalRGBA.content):Buffer.alloc(1024);
  for(let i=1;i<256;i++) rgba.writeUInt32LE(palette[i]!, (i-1)*4);
  const writePalette=!!originalRGBA||scene.models.some(m=>m.palette!==undefined);
  // Metadata chunks are matched to the slot of the original chunk with the same type and id (O(1) per chunk).
  const key=(type:string,id:number)=>`${type}:${id}`;
  const metadata:[string,VoxChunk][]=[...scene.nodes.map(n=>[n.type,metadataChunk(n.type,n)] as [string,VoxChunk]),...scene.layers.map(n=>['LAYR',metadataChunk('LAYR',n)] as [string,VoxChunk]),...scene.materials.map(n=>['MATL',metadataChunk('MATL',n)] as [string,VoxChunk])];
  const byKey=new Map<string,VoxChunk>(); for(const [type,chunk] of metadata) byKey.set(key(type,chunk.content.readInt32LE(0)),chunk);
  const used=new Set<VoxChunk>();
  const {replace,added}=renderChunks(scene.render);
  const owned=renderOwned.get(scene.render)??new Set<VoxChunk>();
  let next=0;
  const children: VoxChunk[]=[];
  for(const c of scene.document.main.children) {
    if(c.id==='SIZE' || c.id==='XYZI') { const replacement=replacements[next++]; if(replacement) children.push(replacement); }
    else if(c.id==='RGBA') {if(writePalette) children.push({...c,content:rgba});}
    else if(c.id==='PACK') { const content=Buffer.alloc(4); content.writeUInt32LE(scene.models.length); children.push({...c,content}); }
    else if(['nTRN','nGRP','nSHP','LAYR','MATL'].includes(c.id)) {
      const replacement=byKey.get(key(c.id,c.content.readInt32LE(0)));
      if(replacement&&!used.has(replacement)) {children.push(replacement); used.add(replacement);}
    } else if((RENDER_CHUNK_IDS as readonly string[]).includes(c.id)&&owned.has(c)) {
      const replacement=replace.get(c); if(replacement) children.push(replacement);
    } else children.push(c);
  }
  children.push(...replacements.slice(next),...metadata.map(([,m])=>m).filter(m=>!used.has(m)),...added);
  if(writePalette&&!originalRGBA) children.push({id:'RGBA',content:rgba,children:[]});
  if(scene.models.length>1&&scene.document.main.children.length===0&&!children.some(c=>c.id==='PACK')) {const content=Buffer.alloc(4); content.writeUInt32LE(scene.models.length); children.unshift({id:'PACK',content,children:[]});}
  const doc={version:scene.document.version,main:{...scene.document.main,children}};
  readDocumentModels(doc);
  return encodeVOXDocument(doc);
}
export function loadVOXScene(path: string, options:ParseOptions={}): VoxScene { return decodeVOXScene(fs.readFileSync(path),options); }
export function saveVOXScene(path: string, scene: VoxScene): void { fs.writeFileSync(path,encodeVOXScene(scene)); }

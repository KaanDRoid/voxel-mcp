import type { VoxModelData, Voxel } from "./vox.js";
import { defaultPalette } from "./vox.js";

export type ModelId = string;

export const MAX_VOXELS = 2_000_000;
export const MAX_WORK = 32_000_000;
export function assertWork(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_WORK) throw new Error(`Work budget exceeded (${MAX_WORK})`);
}
export function validateSize(model: Pick<VoxModelData,"sizeX"|"sizeY"|"sizeZ">): void {
  if (![model.sizeX,model.sizeY,model.sizeZ].every(n=>Number.isInteger(n)&&n>=1&&n<=256)) throw new Error("Model dimensions must be integers 1..256");
}
export function validateIndex(i: number): void {
  if (!Number.isInteger(i)||i<1||i>255) throw new Error("Palette index must be an integer 1..255");
}
function validateVoxel(v: Voxel): void {
  if (![v.x,v.y,v.z].every(Number.isSafeInteger)) throw new Error("Voxel coordinates must be safe integers");
  validateIndex(v.i);
}
export function normalizeModel(model: VoxModelData): void {
  validateSize(model);
  assertWork(model.voxels.length);
  if(model.palette && model.palette.length!==256) throw new Error("Palette must have 256 entries");
  const cells = new Map<number, Voxel>();
  for (const v of model.voxels) {
    validateVoxel(v);
    if (v.x < 0 || v.y < 0 || v.z < 0 || v.x >= model.sizeX || v.y >= model.sizeY || v.z >= model.sizeZ) continue;
    cells.set(v.x+256*v.y+65536*v.z, { ...v });
    if(cells.size>MAX_VOXELS)throw new Error(`Voxel limit exceeded (${MAX_VOXELS})`);
  }
  model.voxels = Array.from(cells.values());
}

export function mutateModel(model: VoxModelData, action: (draft: VoxModelData) => void): VoxModelData {
  const draft = cloneModel(model);
  action(draft);
  normalizeModel(draft);
  Object.assign(model, draft);
  return model;
}

export interface RegistryOptions {
  maxModels?: number;
  maxTotalVoxels?: number;
  historyLimit?: number;
  maxHistoryVoxels?: number;
}
type PackedModel = { sizeX:number;sizeY:number;sizeZ:number;voxels:Uint32Array;palette?:Uint32Array };
type RegistrySnapshot = { nextId:number; models:Map<ModelId,PackedModel>; count:number };

export class ModelRegistry {
  private nextId = 1;
  private models = new Map<ModelId, VoxModelData>();
  private past: RegistrySnapshot[] = [];
  private future: RegistrySnapshot[] = [];
  private busy = false;
  private limits: Required<RegistryOptions>;
  constructor(options: RegistryOptions = {}) {
    this.limits={maxModels:64,maxTotalVoxels:8_000_000,historyLimit:16,maxHistoryVoxels:16_000_000,...options};
    for(const n of Object.values(this.limits))if(!Number.isSafeInteger(n)||n<0)throw new Error("Registry limits must be nonnegative safe integers");
  }
  private check(): void {
    if(this.models.size>this.limits.maxModels)throw new Error("Registry model limit exceeded");
    let count=0;
    for(const model of this.models.values()){normalizeModel(model);count+=model.voxels.length;}
    if(count>this.limits.maxTotalVoxels)throw new Error("Registry voxel limit exceeded");
  }
  private capture(): RegistrySnapshot {
    this.check();
    const models=new Map<ModelId,PackedModel>();let count=0;
    for(const [id,m] of this.models){
      const voxels=Uint32Array.from(m.voxels,v=>(v.x|(v.y<<8)|(v.z<<16)|(v.i<<24))>>>0);
      models.set(id,{sizeX:m.sizeX,sizeY:m.sizeY,sizeZ:m.sizeZ,voxels,...(m.palette?{palette:new Uint32Array(m.palette)}:{})});count+=voxels.length;
    }
    return {nextId:this.nextId,models,count};
  }
  private restore(snapshot:RegistrySnapshot):void {
    const models=new Map<ModelId,VoxModelData>();
    for(const [id,p]of snapshot.models){
      const m=this.models.get(id)??{sizeX:1,sizeY:1,sizeZ:1,voxels:[]};
      m.sizeX=p.sizeX;m.sizeY=p.sizeY;m.sizeZ=p.sizeZ;
      m.voxels=Array.from(p.voxels,n=>({x:n&255,y:(n>>>8)&255,z:(n>>>16)&255,i:n>>>24}));
      if(p.palette)m.palette=new Uint32Array(p.palette);else delete m.palette;
      models.set(id,m);
    }
    this.models=models;this.nextId=snapshot.nextId;
  }
  private trim():void {
    let count=[...this.past,...this.future].reduce((n,s)=>n+s.count,0);
    while(this.past.length+this.future.length>this.limits.historyLimit||count>this.limits.maxHistoryVoxels){
      const removed=this.past.length?this.past.shift():this.future.shift();if(!removed)break;count-=removed.count;
    }
  }
  private directChange():void {if(!this.busy){this.past=[];this.future=[];}}
  async transaction<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.busy)throw new Error("Nested/concurrent registry transactions are not supported");
    const before=this.capture();this.busy=true;
    try {
      const value=await operation();this.check();
      this.future=[];this.past.push(before);this.trim();return value;
    }catch(error){this.restore(before);throw error;}finally{this.busy=false;}
  }
  undo():boolean {
    if(this.busy)throw new Error("Cannot undo during transaction");
    const previous=this.past.at(-1);if(!previous)return false;
    const current=this.capture();this.past.pop();this.future.push(current);this.restore(previous);this.trim();return true;
  }
  redo():boolean {
    if(this.busy)throw new Error("Cannot redo during transaction");
    const next=this.future.at(-1);if(!next)return false;
    const current=this.capture();this.future.pop();this.past.push(current);this.restore(next);this.trim();return true;
  }
  create(sizeX: number, sizeY: number, sizeZ: number): { id: ModelId; model: VoxModelData } {
    validateSize({sizeX,sizeY,sizeZ});
    if(this.models.size>=this.limits.maxModels)throw new Error("Registry model limit exceeded");
    const id=String(this.nextId++),model:VoxModelData={sizeX,sizeY,sizeZ,voxels:[]};
    this.directChange();this.models.set(id,model);return {id,model};
  }
  set(id: ModelId, model: VoxModelData):void {
    const copy=cloneModel(model);normalizeModel(copy);
    if(!this.models.has(id)&&this.models.size>=this.limits.maxModels)throw new Error("Registry model limit exceeded");
    let total=copy.voxels.length;for(const [key,m]of this.models)if(key!==id)total+=m.voxels.length;
    if(total>this.limits.maxTotalVoxels)throw new Error("Registry voxel limit exceeded");
    this.directChange();this.models.set(id,copy);
    if(/^\d+$/.test(id)&&Number.isSafeInteger(Number(id)))this.nextId=Math.max(this.nextId,Number(id)+1);
  }
  get(id: ModelId): VoxModelData {
    const m = this.models.get(id);
    if (!m) throw new Error(`Model ${id} not found`);
    return m;
  }
  list(): { id: string; size: [number, number, number]; voxels: number }[] {
    return Array.from(this.models.entries()).map(([id, m]) => ({ id, size: [m.sizeX, m.sizeY, m.sizeZ], voxels: m.voxels.length }));
  }
  delete(id: ModelId):void {if(this.models.has(id)){this.directChange();this.models.delete(id);}}
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type Bounds = [number, number, number, number, number, number];
function raster(model: VoxModelData, bounds: Bounds, i: number, inside: (x: number, y: number, z: number) => boolean) {
  validateSize(model);validateIndex(i);
  if(!bounds.every(Number.isFinite))throw new Error("Shape bounds must be finite");
  const [x0,y0,z0,x1,y1,z1] = bounds;
  const lx = Math.max(0, Math.ceil(x0)), hx = Math.min(model.sizeX-1, Math.floor(x1));
  const ly = Math.max(0, Math.ceil(y0)), hy = Math.min(model.sizeY-1, Math.floor(y1));
  const lz = Math.max(0, Math.ceil(z0)), hz = Math.min(model.sizeZ-1, Math.floor(z1));
  const work=Math.max(0,hx-lx+1)*Math.max(0,hy-ly+1)*Math.max(0,hz-lz+1);
  assertWork(work);
  if(work>MAX_VOXELS)throw new Error("Raster candidate voxel limit exceeded");
  const added: Voxel[] = [];
  for (let z=lz; z<=hz; z++) for(let y=ly;y<=hy;y++) for(let x=lx;x<=hx;x++) {
    if(inside(x,y,z)) added.push({x,y,z,i});
  }
  setVoxels(model, added);
}
export function fillBox(model: VoxModelData, x0:number,y0:number,z0:number,x1:number,y1:number,z1:number,i:number) {
  raster(model,[Math.min(x0,x1),Math.min(y0,y1),Math.min(z0,z1),Math.max(x0,x1),Math.max(y0,y1),Math.max(z0,z1)],i,()=>true);
}
export function fillSphere(model: VoxModelData,cx:number,cy:number,cz:number,r:number,i:number) {
  if(!Number.isFinite(r)||r<0)throw new Error("Radius must be finite and nonnegative");
  raster(model,[cx-r,cy-r,cz-r,cx+r,cy+r,cz+r],i,(x,y,z)=>(x-cx)**2+(y-cy)**2+(z-cz)**2<=r*r);
}
export function fillCylinder(model: VoxModelData,cx:number,cy:number,z0:number,z1:number,r:number,i:number) {
  if(!Number.isFinite(r)||r<0)throw new Error("Radius must be finite and nonnegative");
  raster(model,[cx-r,cy-r,Math.min(z0,z1),cx+r,cy+r,Math.max(z0,z1)],i,(x,y)=>(x-cx)**2+(y-cy)**2<=r*r);
}
export function fillPyramid(model: VoxModelData,x0:number,y0:number,z0:number,x1:number,y1:number,height:number,i:number) {
  if(!Number.isSafeInteger(height)||height<1)throw new Error("Height must be a positive integer");
  const lx=Math.min(x0,x1),hx=Math.max(x0,x1),ly=Math.min(y0,y1),hy=Math.max(y0,y1);
  const cx=(lx+hx)/2,cy=(ly+hy)/2;
  raster(model,[lx,ly,z0,hx,hy,z0+height-1],i,(x,y,z)=>{
    const t=1-(z-z0)/height;
    return x>=Math.floor(cx-(hx-lx)/2*t)&&x<=Math.ceil(cx+(hx-lx)/2*t)&&y>=Math.floor(cy-(hy-ly)/2*t)&&y<=Math.ceil(cy+(hy-ly)/2*t);
  });
}
export function fillCone(model: VoxModelData,cx:number,cy:number,z0:number,r:number,height:number,i:number) {
  if(!Number.isFinite(r)||r<0||!Number.isSafeInteger(height)||height<1)throw new Error("Invalid cone radius/height");
  raster(model,[cx-r,cy-r,z0,cx+r,cy+r,z0+height-1],i,(x,y,z)=>(x-cx)**2+(y-cy)**2<=(r*(1-(z-z0)/height))**2);
}
export function fillTorus(model: VoxModelData,cx:number,cy:number,cz:number,majorR:number,minorR:number,i:number) {
  if(![majorR,minorR].every(n=>Number.isFinite(n)&&n>=0))throw new Error("Radii must be finite and nonnegative");
  const r=majorR+minorR;
  raster(model,[cx-r,cy-r,cz-minorR,cx+r,cy+r,cz+minorR],i,(x,y,z)=>(Math.hypot(x-cx,y-cy)-majorR)**2+(z-cz)**2<=minorR**2);
}
export function drawLine(model: VoxModelData,x0:number,y0:number,z0:number,x1:number,y1:number,z1:number,i:number) {
  validateSize(model);validateIndex(i);
  if(![x0,y0,z0,x1,y1,z1].every(Number.isSafeInteger))throw new Error("Line coordinates must be safe integers");
  const steps=Math.max(Math.abs(x1-x0),Math.abs(y1-y0),Math.abs(z1-z0));
  assertWork(steps+1);
  if(steps+1>MAX_VOXELS)throw new Error("Line voxel limit exceeded");
  const out:Voxel[]=[];
  for(let n=0;n<=steps;n++) {const t=steps===0?0:n/steps;out.push({x:Math.round(x0+(x1-x0)*t),y:Math.round(y0+(y1-y0)*t),z:Math.round(z0+(z1-z0)*t),i});}
  setVoxels(model,out);
}

export function scaleModel(model: VoxModelData, scaleX: number, scaleY: number, scaleZ: number): VoxModelData {
  if (![scaleX,scaleY,scaleZ].every(n=>Number.isFinite(n)&&n>0)) throw new Error("Scale must be finite and positive");
  const source=cloneModel(model);normalizeModel(source);
  const sx=Math.max(1,Math.round(model.sizeX*scaleX)),sy=Math.max(1,Math.round(model.sizeY*scaleY)),sz=Math.max(1,Math.round(model.sizeZ*scaleZ));
  if([sx,sy,sz].some(n=>n>256))throw new Error("Scaled size exceeds 256");
  const out:VoxModelData={sizeX:sx,sizeY:sy,sizeZ:sz,voxels:[]};
  assertWork(sx*sy*sz);
  if(model.palette)out.palette=new Uint32Array(model.palette);
  const cells=new Map(source.voxels.map(v=>[`${v.x},${v.y},${v.z}`,v.i]));
  for(let z=0;z<sz;z++)for(let y=0;y<sy;y++)for(let x=0;x<sx;x++){
    const i=cells.get(`${Math.floor(x*model.sizeX/sx)},${Math.floor(y*model.sizeY/sy)},${Math.floor(z*model.sizeZ/sz)}`);
    if(i!==undefined){if(out.voxels.length>=MAX_VOXELS)throw new Error("Scaled voxel limit exceeded");out.voxels.push({x,y,z,i});}
  }
  return out;
}

export function cloneModel(model: VoxModelData): VoxModelData {
  validateSize(model);assertWork(model.voxels.length);
  const out: VoxModelData = {
    sizeX: model.sizeX,
    sizeY: model.sizeY,
    sizeZ: model.sizeZ,
    voxels: model.voxels.map(v => ({ ...v }))
  };
  if (model.palette) out.palette = new Uint32Array(model.palette);
  return out;
}

export function clearRegion(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
  model.voxels = model.voxels.filter(v => 
    v.x < minX || v.x > maxX || v.y < minY || v.y > maxY || v.z < minZ || v.z > maxZ
  );
}

export function copyRegion(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Voxel[] {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
  return model.voxels
    .filter(v => v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY && v.z >= minZ && v.z <= maxZ)
    .map(v => ({ x: v.x - minX, y: v.y - minY, z: v.z - minZ, i: v.i }));
}

export function pasteRegion(model: VoxModelData, voxels: Voxel[], offsetX: number, offsetY: number, offsetZ: number) {
  if(![offsetX,offsetY,offsetZ].every(Number.isSafeInteger))throw new Error("Paste offsets must be safe integers");
  assertWork(voxels.length);
  setVoxels(model,voxels.map(v=>({...v,x:v.x+offsetX,y:v.y+offsetY,z:v.z+offsetZ})));
}

export function getModelInfo(model: VoxModelData): {
  size: [number, number, number];
  voxelCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  usedColors: number[];
} {
  let minX = model.sizeX, minY = model.sizeY, minZ = model.sizeZ;
  let maxX = 0, maxY = 0, maxZ = 0;
  const colorSet = new Set<number>();
  
  for (const v of model.voxels) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    colorSet.add(v.i);
  }
  
  return {
    size: [model.sizeX, model.sizeY, model.sizeZ],
    voxelCount: model.voxels.length,
    boundingBox: {
      min: model.voxels.length > 0 ? [minX, minY, minZ] : [0, 0, 0],
      max: model.voxels.length > 0 ? [maxX, maxY, maxZ] : [0, 0, 0]
    },
    usedColors: Array.from(colorSet).sort((a, b) => a - b)
  };
}

export function setVoxels(model: VoxModelData, voxels: Voxel[]) {
  assertWork(model.voxels.length+voxels.length);
  const draft={...model,voxels:model.voxels.concat(voxels)};
  normalizeModel(draft);model.voxels=draft.voxels;
}

export function translate(model: VoxModelData, dx: number, dy: number, dz: number, policy: "clip" | "expand" | "error" = "clip") {
  if (![dx,dy,dz].every(Number.isSafeInteger)) throw new Error("Translation must use integer offsets");
  if (!["clip","expand","error"].includes(policy)) throw new Error("Invalid translation policy");
  mutateModel(model, draft => {
    draft.voxels = draft.voxels.map(v => ({...v,x:v.x+dx,y:v.y+dy,z:v.z+dz}));
    const outside = (v:Voxel) => v.x<0||v.y<0||v.z<0||v.x>=draft.sizeX||v.y>=draft.sizeY||v.z>=draft.sizeZ;
    if(policy === "error" && draft.voxels.some(outside)) throw new Error("Translation outside model bounds");
    if(policy === "expand") {
      let lx=0,ly=0,lz=0,hx=draft.sizeX-1,hy=draft.sizeY-1,hz=draft.sizeZ-1;
      for(const v of draft.voxels){lx=Math.min(lx,v.x);ly=Math.min(ly,v.y);lz=Math.min(lz,v.z);hx=Math.max(hx,v.x);hy=Math.max(hy,v.y);hz=Math.max(hz,v.z);}
      draft.sizeX=hx-lx+1;draft.sizeY=hy-ly+1;draft.sizeZ=hz-lz+1;
      if([draft.sizeX,draft.sizeY,draft.sizeZ].some(n=>n>256)) throw new Error("Expanded size exceeds 256");
      for(const v of draft.voxels){v.x-=lx;v.y-=ly;v.z-=lz;}
    }
  });
}

export function rotate90(model: VoxModelData, axis: "x" | "y" | "z") {
  if(!["x","y","z"].includes(axis))throw new Error("Invalid rotation axis");
  normalizeModel(model);
  // Swap dimensions appropriately
  const oldSizeX = model.sizeX, oldSizeY = model.sizeY, oldSizeZ = model.sizeZ;
  
  for (const v of model.voxels) {
    const x = v.x, y = v.y, z = v.z;
    switch (axis) {
      case "x":
        v.y = oldSizeZ - 1 - z;
        v.z = y;
        break;
      case "y":
        v.x = z;
        v.z = oldSizeX - 1 - x;
        break;
      case "z":
        v.x = oldSizeY - 1 - y;
        v.y = x;
        break;
    }
  }
  
  // Update model dimensions
  switch (axis) {
    case "x":
      model.sizeY = oldSizeZ;
      model.sizeZ = oldSizeY;
      break;
    case "y":
      model.sizeX = oldSizeZ;
      model.sizeZ = oldSizeX;
      break;
    case "z":
      model.sizeX = oldSizeY;
      model.sizeY = oldSizeX;
      break;
  }
}

export function booleanOp(a: VoxModelData, b: VoxModelData, op: "union" | "intersect" | "difference"): VoxModelData {
  if(!["union","intersect","difference"].includes(op))throw new Error("Invalid boolean operation");
  a=cloneModel(a);b=cloneModel(b);normalizeModel(a);normalizeModel(b);
  const key=(v:Voxel)=>v.x+256*v.y+65536*v.z;
  const aa=new Map(a.voxels.map(v=>[key(v),v])),bb=new Map(b.voxels.map(v=>[key(v),v]));
  const dimension=op==="union"?Math.max:op==="intersect"?Math.min:(x:number)=>x;
  const out:VoxModelData={sizeX:dimension(a.sizeX,b.sizeX),sizeY:dimension(a.sizeY,b.sizeY),sizeZ:dimension(a.sizeZ,b.sizeZ),voxels:[],palette:new Uint32Array(256)};
  const palA=a.palette??defaultPalette(),palB=b.palette??defaultPalette();
  const colors=new Map<number,number>();
  const add=(v:Voxel,palette:Uint32Array)=>{
    const color=palette[v.i]!;let i=colors.get(color);
    if(i===undefined){if(colors.size===255)throw new Error("Boolean result exceeds 255 palette colors");i=colors.size+1;colors.set(color,i);out.palette![i]=color;}
    if(out.voxels.length>=MAX_VOXELS)throw new Error("Voxel limit exceeded");
    out.voxels.push({...v,i});
  };
  for(const [k,v]of aa)if(op==="union"||(op==="intersect"?bb.has(k):!bb.has(k)))add(v,palA);
  if(op==="union")for(const [k,v]of bb)if(!aa.has(k))add(v,palB);
  return out;
}

export function cropToContent(model: VoxModelData) {
  normalizeModel(model);
  if (model.voxels.length === 0) return;
  let minX = model.sizeX, minY = model.sizeY, minZ = model.sizeZ, maxX = 0, maxY = 0, maxZ = 0;
  for (const v of model.voxels) { if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z; if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z; }
  const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1;
  const out: VoxModelData = { sizeX: nx, sizeY: ny, sizeZ: nz, voxels: [] } as any;
  if (model.palette) (out as any).palette = model.palette;
  for (const v of model.voxels) out.voxels.push({ x: v.x - minX, y: v.y - minY, z: v.z - minZ, i: v.i });
  model.sizeX = out.sizeX; model.sizeY = out.sizeY; model.sizeZ = out.sizeZ; model.voxels = out.voxels;
}

export function centerModel(model: VoxModelData) {
  const cx = Math.floor((model.sizeX - 1) / 2), cy = Math.floor((model.sizeY - 1) / 2), cz = Math.floor((model.sizeZ - 1) / 2);
  const info = getModelInfo(model);
  const bx = Math.floor((info.boundingBox.min[0] + info.boundingBox.max[0]) / 2);
  const by = Math.floor((info.boundingBox.min[1] + info.boundingBox.max[1]) / 2);
  const bz = Math.floor((info.boundingBox.min[2] + info.boundingBox.max[2]) / 2);
  translate(model, cx - bx, cy - by, cz - bz);
}

export function alignToGround(model: VoxModelData) {
  const info = getModelInfo(model);
  translate(model, 0, 0, -info.boundingBox.min[2]);
}

export function flipModel(model: VoxModelData, axis: "x" | "y" | "z") {
  if(!["x","y","z"].includes(axis))throw new Error("Invalid flip axis");
  normalizeModel(model);
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  for (const v of model.voxels) {
    if (axis === "x") v.x = (sx - 1) - v.x;
    else if (axis === "y") v.y = (sy - 1) - v.y;
    else v.z = (sz - 1) - v.z;
  }
}

export function rotateArbitrary(model: VoxModelData, axis: "x" | "y" | "z", degrees: number) {
  if(!["x","y","z"].includes(axis)||!Number.isFinite(degrees))throw new Error("Invalid rotation axis or degrees");
  normalizeModel(model);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (model.sizeX - 1) / 2, cy = (model.sizeY - 1) / 2, cz = (model.sizeZ - 1) / 2;
  for (const v of model.voxels) {
    const x = v.x - cx, y = v.y - cy, z = v.z - cz;
    if (axis === "z") {
      const nx = Math.round(x * cos - y * sin), ny = Math.round(x * sin + y * cos);
      v.x = Math.round(nx + cx);
      v.y = Math.round(ny + cy);
    } else if (axis === "y") {
      const nx = Math.round(x * cos + z * sin), nz = Math.round(-x * sin + z * cos);
      v.x = Math.round(nx + cx);
      v.z = Math.round(nz + cz);
    } else {
      const ny = Math.round(y * cos - z * sin), nz = Math.round(y * sin + z * cos);
      v.y = Math.round(ny + cy);
      v.z = Math.round(nz + cz);
    }
  }
  normalizeModel(model);
}

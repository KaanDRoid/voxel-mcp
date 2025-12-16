import fs from "fs";
import { PNG } from "pngjs";
import type { VoxModelData } from "./vox.js";

export type AnimationId = string;

export class AnimationRegistry {
  private next = 1;
  private anims = new Map<AnimationId, AnimationData>();
  create(name?: string): AnimationId { const id = String(this.next++); this.anims.set(id, { name: name ?? `anim_${id}` , fps: 12, loop: true, frames: [] }); return id; }
  addFrame(id: AnimationId, model: VoxModelData, durationMs?: number) { const a = this.data(id); a.frames.push({ model: structuredCloneModel(model), durationMs: durationMs ?? Math.round(1000 / a.fps) }); }
  replaceFrame(id: AnimationId, index: number, model: VoxModelData) { const a = this.data(id); a.frames[index] = { ...a.frames[index]!, model: structuredCloneModel(model) }; }
  removeFrame(id: AnimationId, index: number) { const a = this.data(id); a.frames.splice(index, 1); }
  clearFrames(id: AnimationId) { const a = this.data(id); a.frames = []; }
  getFrames(id: AnimationId) { return this.data(id).frames.map(f => structuredCloneModel(f.model)); }
  getData(id: AnimationId) { return this.data(id); }
  setFps(id: AnimationId, fps: number) { const a = this.data(id); a.fps = Math.max(1, Math.floor(fps)); for (const f of a.frames) f.durationMs = Math.round(1000 / a.fps); }
  setLoop(id: AnimationId, loop: boolean) { this.data(id).loop = loop; }
  setFrameDuration(id: AnimationId, index: number, durationMs: number) { const a = this.data(id); a.frames[index]!.durationMs = Math.max(1, Math.floor(durationMs)); }
  totalDuration(id: AnimationId) { const a = this.data(id); return a.frames.reduce((s,f)=>s+(f.durationMs||0),0); }
  reverse(id: AnimationId) { const a = this.data(id); a.frames.reverse(); }
  duplicateFrame(id: AnimationId, index: number) { const a = this.data(id); const f=a.frames[index]!; a.frames.splice(index+1, 0, { model: structuredCloneModel(f.model), durationMs: f.durationMs }); }
  reorder(id: AnimationId, from: number, to: number) { const a = this.data(id); const [f] = a.frames.splice(from,1); a.frames.splice(to, 0, f!); }
  concat(intoId: AnimationId, fromId: AnimationId) { const A=this.data(intoId), B=this.data(fromId); A.frames.push(...B.frames.map(f=>({ model: structuredCloneModel(f.model), durationMs: f.durationMs }))); }
  private data(id: AnimationId): AnimationData { const a = this.anims.get(id); if (!a) throw new Error("animation not found"); return a; }
}

export interface AnimationData {
  name: string;
  fps: number;
  loop: boolean;
  frames: { model: VoxModelData; durationMs: number }[];
}

function structuredCloneModel(m: VoxModelData): VoxModelData {
  const out: VoxModelData = { sizeX: m.sizeX, sizeY: m.sizeY, sizeZ: m.sizeZ, voxels: m.voxels.map(v => ({ ...v })) };
  if (m.palette) (out as any).palette = new Uint32Array(m.palette);
  return out;
}

export function interpolateFrames(a: VoxModelData, b: VoxModelData, steps: number): VoxModelData[] {
  // Naive interpolation: union with progressive blend (every other voxel toggled)
  if (a.sizeX !== b.sizeX || a.sizeY !== b.sizeY || a.sizeZ !== b.sizeZ) throw new Error("frame sizes differ");
  const out: VoxModelData[] = [];
  const setA = new Set(a.voxels.map(v => `${v.x},${v.y},${v.z}`));
  const setB = new Set(b.voxels.map(v => `${v.x},${v.y},${v.z}`));
  const union = new Set<string>([...setA, ...setB]);
  for (let s = 1; s <= steps; s++) {
    const m: VoxModelData = { sizeX: a.sizeX, sizeY: a.sizeY, sizeZ: a.sizeZ, voxels: [] };
    let i = 0;
    for (const key of union) {
      if (i % (steps + 1) <= s) {
        const parts = key.split(",").map(Number);
        m.voxels.push({ x: Number(parts[0] ?? 0), y: Number(parts[1] ?? 0), z: Number(parts[2] ?? 0), i: 200 });
      }
      i++;
    }
    out.push(m);
  }
  return out;
}

export function exportAnimationSpriteSheet(frames: VoxModelData[], path: string) {
  if (frames.length === 0) throw new Error("no frames");
  const sx = frames[0]!.sizeX, sy = frames[0]!.sizeY, sz = frames[0]!.sizeZ;
  const sheet = new PNG({ width: sx * frames.length, height: sy });
  const idx2d = (x:number,y:number,w:number) => (y*w + x) * 4;
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi]!;
    const occ = new Uint8Array(sx * sy * sz);
    const idx3d = (x: number, y: number, z: number) => x + sx * (y + sy * z);
    for (const v of f.voxels) occ[idx3d(v.x, v.y, v.z)] = v.i;
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        // composite max intensity along Z
        let c = 0; for (let z = 0; z < sz; z++) { const val = occ[idx3d(x,y,z)] ?? 0; c = Math.max(c, Number(val)); }
        const di = idx2d(x + fi * sx, sy - 1 - y, sheet.width);
        sheet.data[di+0] = c; sheet.data[di+1] = c; sheet.data[di+2] = c; sheet.data[di+3] = c ? 255 : 0;
      }
    }
  }
  fs.writeFileSync(path, PNG.sync.write(sheet));
}

export function exportAnimationGIF(_frames: VoxModelData[], _path: string) {
  throw new Error("export_animation_gif is not available in this build; use export_animation_spritesheet instead");
}

export type Projection = "top" | "front" | "side" | "zmax" | "isometric";

export function renderFrameToPNG(frame: VoxModelData, projection: Projection = "zmax"): any {
  if (projection === "zmax" || projection === "top" || projection === "front" || projection === "side") {
    const sx = frame.sizeX, sy = frame.sizeY, sz = frame.sizeZ;
    const png = new PNG({ width: sx, height: sy });
    const idx = (x:number,y:number) => (y*sx + x)*4;
    const occ = new Uint8Array(sx*sy*sz);
    const id3 = (x:number,y:number,z:number)=>x+sx*(y+sy*z);
    for (const v of frame.voxels) occ[id3(v.x,v.y,v.z)] = v.i;
    for (let y=0;y<sy;y++) for (let x=0;x<sx;x++) {
      let c=0;
      if (projection==="zmax"||projection==="top") { for (let z=0; z<sz; z++) c=Math.max(c, occ[id3(x,y,z)]??0); }
      else if (projection==="front") { for (let z=0; z<sz; z++) c=Math.max(c, occ[id3(x,z,y)]??0); }
      else { for (let z=0; z<sz; z++) c=Math.max(c, occ[id3(z,y,x)]??0); }
      const di = idx(x, sy-1-y); png.data[di]=c; png.data[di+1]=c; png.data[di+2]=c; png.data[di+3]= c?255:0;
    }
    return png;
  }
  // isometric rendering (simple painter's algorithm)
  const W = frame.sizeX + frame.sizeY + 10;
  const H = Math.floor((frame.sizeX + frame.sizeY)/2) + frame.sizeZ + 10;
  const png = new PNG({ width: W, height: H });
  const put = (x:number,y:number,i:number)=>{
    if (x<0||y<0||x>=W||y>=H) return; const di=(y*W+x)*4; png.data[di]=i; png.data[di+1]=i; png.data[di+2]=i; png.data[di+3]=255;
  };
  const sort = frame.voxels.slice().sort((a,b)=> (a.x+a.y+a.z) - (b.x+b.y+b.z));
  const ox = Math.floor(W/2), oy = 5;
  for (const v of sort) {
    const px = ox + (v.x - v.y);
    const py = oy + Math.floor((v.x + v.y)/2) - v.z;
    put(px, py, v.i);
  }
  return png;
}

export function exportAnimationFrames(frames: VoxModelData[], folder: string, projection: Projection = "zmax") {
  const fs = require("fs");
  fs.mkdirSync(folder, { recursive: true });
  for (let i=0;i<frames.length;i++) {
    const png = renderFrameToPNG(frames[i]!, projection);
    const buf = PNG.sync.write(png);
    fs.writeFileSync(`${folder}/frame_${String(i).padStart(4,"0")}.png`, buf);
  }
}

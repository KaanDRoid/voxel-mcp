import fs from "fs";
import { PNG } from "pngjs";
import gifenc from "gifenc";
import { defaultPalette, type VoxModelData } from "./vox.js";
import { writeFileNoFollow } from "./export.js";
import { medianCut } from "./color.js";

const { GIFEncoder } = gifenc;
const FALLBACK_PALETTE = defaultPalette();

export type AnimationId = string;

export class AnimationRegistry {
  private next = 1;
  private anims = new Map<AnimationId, AnimationData>();
  create(name?: string): AnimationId { if (this.anims.size >= 16) throw new Error("Animation limit exceeded (16)"); const id = String(this.next++); this.anims.set(id, { name: name ?? `anim_${id}` , fps: 12, loop: true, frames: [] }); return id; }
  addFrame(id: AnimationId, model: VoxModelData, durationMs?: number) { const a = this.data(id); this.checkCapacity(model.voxels.length); a.frames.push({ model: structuredCloneModel(model), durationMs: durationMs ?? Math.round(1000 / a.fps) }); }
  replaceFrame(id: AnimationId, index: number, model: VoxModelData) { const a = this.data(id); a.frames[index] = { ...a.frames[index]!, model: structuredCloneModel(model) }; }
  removeFrame(id: AnimationId, index: number) { const a = this.data(id); a.frames.splice(index, 1); }
  clearFrames(id: AnimationId) { const a = this.data(id); a.frames = []; }
  getFrames(id: AnimationId) { return this.data(id).frames.map(f => structuredCloneModel(f.model)); }
  getData(id: AnimationId) { return this.data(id); }
  setFps(id: AnimationId, fps: number) { const a = this.data(id); a.fps = Math.max(1, Math.floor(fps)); for (const f of a.frames) f.durationMs = Math.round(1000 / a.fps); }
  setLoop(id: AnimationId, loop: boolean) { this.data(id).loop = loop; }
  setFrameDuration(id: AnimationId, index: number, durationMs: number) { const a = this.data(id); if (!a.frames[index]) throw new Error("frame index out of range"); a.frames[index]!.durationMs = Math.max(1, Math.floor(durationMs)); }
  totalDuration(id: AnimationId) { const a = this.data(id); return a.frames.reduce((s,f)=>s+(f.durationMs||0),0); }
  reverse(id: AnimationId) { const a = this.data(id); a.frames.reverse(); }
  duplicateFrame(id: AnimationId, index: number) { const a = this.data(id); const f=a.frames[index]; if (!f) throw new Error("frame index out of range"); this.checkCapacity(f.model.voxels.length); a.frames.splice(index+1, 0, { model: structuredCloneModel(f.model), durationMs: f.durationMs }); }
  reorder(id: AnimationId, from: number, to: number) { const a = this.data(id); if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < a.frames.length)) throw new Error("frame index out of range"); const [f] = a.frames.splice(from,1); a.frames.splice(to, 0, f!); }
  concat(intoId: AnimationId, fromId: AnimationId) { const A=this.data(intoId), B=this.data(fromId); A.frames.push(...B.frames.map(f=>({ model: structuredCloneModel(f.model), durationMs: f.durationMs }))); }
  private checkCapacity(adding: number) {
    let frames = 0, voxels = adding;
    for (const a of this.anims.values()) { frames += a.frames.length; for (const f of a.frames) voxels += f.model.voxels.length; }
    if (frames >= 512 || voxels > 8_000_000) throw new Error("Animation storage limit exceeded");
  }
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
  if (m.palette) out.palette = new Uint32Array(m.palette);
  return out;
}

export function interpolateFrames(a: VoxModelData, b: VoxModelData, steps: number): VoxModelData[] {
  // Spatial dissolve only: no motion correspondence between arbitrary voxels is assumed.
  // Return `steps` intermediate frames; callers keep the unchanged endpoints.
  if (!Number.isInteger(steps) || steps < 0) throw new Error("steps must be a nonnegative integer");
  checkFrameSizes([a,b]);
  const key = (v: VoxModelData["voxels"][number]) => `${v.x},${v.y},${v.z}`;
  const A = new Map(a.voxels.filter(v=>validVoxel(a,v)).map(v=>[key(v),v]));
  const B = new Map(b.voxels.filter(v=>validVoxel(b,v)).map(v=>[key(v),v]));
  const keys = [...new Set([...A.keys(),...B.keys()])].sort();
  const paletteA = a.palette ?? defaultPalette(), paletteB = b.palette ?? defaultPalette();
  return Array.from({length:steps},(_,s) => {
    const t = (s+1)/(steps+1);
    const palette = new Uint32Array(256);
    const colors = new Map<number,number>();
    const voxels: VoxModelData["voxels"] = [];
    for (let ki=0;ki<keys.length;ki++) {
      const k = keys[ki]!;
      // Evenly distributed, stable thresholds ensure voxels switch once, never flicker.
      const useB = t >= (ki+1)/(keys.length+1);
      const v = (useB ? B : A).get(k);
      if (!v) continue;
      const color = (useB ? paletteB : paletteA)[v.i] ?? 0;
      let index = colors.get(color);
      if (index === undefined) {
        index = colors.size+1;
        if (index > 255) throw new Error("crossfade frame exceeds 255 colors");
        colors.set(color,index); palette[index]=color;
      }
      voxels.push({...v,i:index});
    }
    return {sizeX:a.sizeX,sizeY:a.sizeY,sizeZ:a.sizeZ,voxels,palette};
  });
}

export function exportAnimationSpriteSheet(frames: VoxModelData[], path: string) {
  checkFrameSizes(frames);
  const first = renderFrameToPNG(frames[0]!);
  const sheet = new PNG({ width: first.width * frames.length, height: first.height });
  for (let fi = 0; fi < frames.length; fi++) {
    const png = renderFrameToPNG(frames[fi]!);
    for (let y = 0; y < png.height; y++) {
      png.data.copy(sheet.data,(y*sheet.width+fi*png.width)*4,y*png.width*4,(y+1)*png.width*4);
    }
  }
  fs.writeFileSync(path, PNG.sync.write(sheet));
}

export interface GifOptions {
  /** "none" (default) fails when a frame has too many colors; "median-cut" reduces them. */
  quantize?: "none" | "median-cut" | undefined;
  /** Error diffusion used when colors were reduced. */
  dither?: "none" | "floyd" | undefined;
  /** Largest number of opaque colors per frame, 2..255 (default 255; index 0 is the transparent slot). */
  maxColors?: number | undefined;
}

/** Converts an RGBA frame to GIF palette indices (index 0 = transparent, alpha below 128). */
export function gifFrameIndices(png: { width: number; height: number; data: Uint8Array | Buffer }, opts: GifOptions = {}) {
  const limit = opts.maxColors ?? 255;
  if (!Number.isInteger(limit) || limit < 2 || limit > 255) throw new Error("maxColors must be an integer in 2..255");
  const n = png.width * png.height;
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (png.data[i * 4 + 3]! < 128) continue;
    const key = (png.data[i * 4]! << 16) | (png.data[i * 4 + 1]! << 8) | png.data[i * 4 + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const palette: number[][] = [[0, 0, 0]];
  const indices = new Uint8Array(n);
  const warnings: string[] = [];
  const unpack = (k: number) => [(k >> 16) & 255, (k >> 8) & 255, k & 255] as [number, number, number];
  if (counts.size <= limit) {
    const lookup = new Map<number, number>();
    for (const key of counts.keys()) { lookup.set(key, palette.length); palette.push(unpack(key)); }
    for (let i = 0; i < n; i++) {
      if (png.data[i * 4 + 3]! < 128) continue;
      indices[i] = lookup.get((png.data[i * 4]! << 16) | (png.data[i * 4 + 1]! << 8) | png.data[i * 4 + 2]!)!;
    }
    return { palette, indices, warnings };
  }
  if (opts.quantize !== "median-cut") throw new Error(`GIF frame exceeds ${limit} opaque colors (use quantize "median-cut" to reduce them)`);
  const reps = medianCut([...counts].map(([key, weight]) => ({ rgb: unpack(key), weight })), limit);
  for (const c of reps) palette.push(c);
  const nearest = (r: number, g: number, b: number) => {
    let best = 1, bestD = Infinity;
    for (let i = 1; i < palette.length; i++) {
      const c = palette[i]!;
      const d = (r - c[0]!) ** 2 + (g - c[1]!) ** 2 + (b - c[2]!) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const dither = opts.dither === "floyd";
  const err = dither ? new Float32Array(n * 3) : undefined;
  const cache = new Map<number, number>();
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = y * png.width + x;
    if (png.data[i * 4 + 3]! < 128) continue;
    let r = png.data[i * 4]!, g = png.data[i * 4 + 1]!, b = png.data[i * 4 + 2]!, idx: number;
    if (err) {
      const rr = Math.max(0, Math.min(255, Math.round(r + err[i * 3]!))), gg = Math.max(0, Math.min(255, Math.round(g + err[i * 3 + 1]!))), bb = Math.max(0, Math.min(255, Math.round(b + err[i * 3 + 2]!)));
      idx = nearest(rr, gg, bb);
      const c = palette[idx]!, e = [rr - c[0]!, gg - c[1]!, bb - c[2]!];
      const spread = (dx: number, dy: number, w: number) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= png.width || ny >= png.height) return;
        const j = ny * png.width + nx;
        for (let k = 0; k < 3; k++) err[j * 3 + k]! += e[k]! * w;
      };
      spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
    } else {
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (hit === undefined) { hit = nearest(r, g, b); cache.set(key, hit); }
      idx = hit;
    }
    indices[i] = idx;
  }
  warnings.push(`${counts.size} opaque colors reduced to ${reps.length} with median-cut${dither ? " and Floyd-Steinberg dithering" : ""}`);
  return { palette, indices, warnings };
}

export function exportAnimationGIF(input: VoxModelData[] | AnimationData, path: string, projection: Projection = "zmax", opts: GifOptions = {}): { frames: number; warnings: string[] } {
  const animation: AnimationData = Array.isArray(input)
    ? { name: "", fps: 12, loop: true, frames: input.map(model => ({ model, durationMs: 1000 / 12 })) }
    : input;
  checkFrameSizes(animation.frames.map(f => f.model));
  const gif = GIFEncoder();
  const warnings: string[] = [];
  animation.frames.forEach((f, frameNo) => {
    if (!Number.isFinite(f.durationMs) || f.durationMs <= 0 || f.durationMs > 655350) throw new Error("GIF duration must be between 1 and 655350 ms");
    const png = renderFrameToPNG(f.model, projection);
    if (png.width > 65535 || png.height > 65535) throw new Error("GIF dimensions exceed 65535");
    const { palette, indices, warnings: w } = gifFrameIndices(png, opts);
    for (const message of w) warnings.push(`Frame ${frameNo}: ${message}`);
    gif.writeFrame(indices, png.width, png.height, { palette, delay: Math.max(10, Math.round(f.durationMs / 10) * 10), repeat: animation.loop ? 0 : -1, transparent: true, transparentIndex: 0, dispose: 2 });
  });
  gif.finish();
  fs.writeFileSync(path, gif.bytes());
  return { frames: animation.frames.length, warnings };
}
function checkFrameSizes(frames: VoxModelData[]) {
  if (!frames.length) throw new Error("no frames");
  const first = frames[0]!;
  if (frames.some(f=>f.sizeX!==first.sizeX || f.sizeY!==first.sizeY || f.sizeZ!==first.sizeZ)) throw new Error("frame sizes differ");
}

/** Model colors are packed ARGB; index zero denotes empty space. */
export function voxelColor(frame: VoxModelData, index: number): [number, number, number, number] {
  const c = (frame.palette ?? FALLBACK_PALETTE)[index] ?? 0;
  return [(c >>> 16) & 255, (c >>> 8) & 255, c & 255, (c >>> 24) & 255];
}
function validVoxel(frame: VoxModelData, v: VoxModelData["voxels"][number]): boolean {
  return v.i > 0 && [v.x, v.y, v.z].every(Number.isInteger) && v.x >= 0 && v.x < frame.sizeX && v.y >= 0 && v.y < frame.sizeY && v.z >= 0 && v.z < frame.sizeZ;
}

export type Projection = "top" | "front" | "side" | "zmax" | "isometric";

export function renderFrameToPNG(frame: VoxModelData, projection: Projection = "zmax"): InstanceType<typeof PNG> {
  if (projection === "zmax" || projection === "top" || projection === "front" || projection === "side") {
    const sx = frame.sizeX, sy = frame.sizeY, sz = frame.sizeZ;
    const width = projection === "side" ? sy : sx;
    const height = projection === "top" || projection === "zmax" ? sy : sz;
    const png = new PNG({ width, height });
    const depths = new Int32Array(width * height).fill(-1);
    for (const v of frame.voxels) {
      if (!validVoxel(frame, v)) continue;
      const x = projection === "side" ? v.y : v.x;
      const y = height - 1 - (projection === "top" || projection === "zmax" ? v.y : v.z);
      const depth = projection === "side" ? v.x : projection === "front" ? v.y : v.z;
      const pi = y * width + x;
      const rgba = voxelColor(frame, v.i);
      if (rgba[3] === 0 || depth < depths[pi]!) continue;
      depths[pi] = depth;
      png.data.set(rgba, pi * 4);
    }
    return png;
  }
  // Orthographic isometric cube faces, viewed from positive X/Y/Z.
  const W = 2 * (frame.sizeX + frame.sizeY) + 1;
  const H = frame.sizeX + frame.sizeY + 2 * frame.sizeZ + 1;
  const png = new PNG({ width: W, height: H });
  const project = (x: number, y: number, z: number): [number, number] => [2 * (x - y + frame.sizeY), x + y + 2 * (frame.sizeZ - z)];
  const triangle = (a: number[], b: number[], c: number[], color: number[]) => {
    const cross = (p: number[], q: number[], x: number, y: number) => (q[0]! - p[0]!) * (y - p[1]!) - (q[1]! - p[1]!) * (x - p[0]!);
    for (let y = Math.max(0, Math.min(a[1]!, b[1]!, c[1]!)); y < Math.min(H, Math.max(a[1]!, b[1]!, c[1]!)); y++) {
      for (let x = Math.max(0, Math.min(a[0]!, b[0]!, c[0]!)); x < Math.min(W, Math.max(a[0]!, b[0]!, c[0]!)); x++) {
        const signs = [cross(a,b,x+.5,y+.5), cross(b,c,x+.5,y+.5), cross(c,a,x+.5,y+.5)];
        if (signs.every(s => s >= 0) || signs.every(s => s <= 0)) png.data.set(color, (y * W + x) * 4);
      }
    }
  };
  const sorted = frame.voxels.filter(v => validVoxel(frame,v)).sort((a,b) => a.x+a.y+a.z-b.x-b.y-b.z || a.z-b.z || a.y-b.y || a.x-b.x);
  for (const v of sorted) {
    const color = voxelColor(frame,v.i);
    if (!color[3]) continue;
    for (const corners of [
      [[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
      [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
      [[0,1,0],[0,1,1],[1,1,1],[1,1,0]],
    ]) {
      const pts = corners.map(([x,y,z]) => project(v.x+x!,v.y+y!,v.z+z!));
      triangle(pts[0]!,pts[1]!,pts[2]!,color); triangle(pts[0]!,pts[2]!,pts[3]!,color);
    }
  }
  return png;
}

export function exportAnimationFrames(frames: VoxModelData[], folder: string, projection: Projection = "zmax") {
  checkFrameSizes(frames);
  fs.mkdirSync(folder, { recursive: true });
  for (let i=0;i<frames.length;i++) {
    const png = renderFrameToPNG(frames[i]!, projection);
    const buf = PNG.sync.write(png);
    writeFileNoFollow(`${folder}/frame_${String(i).padStart(4,"0")}.png`, buf);
  }
}

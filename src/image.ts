import fs from "fs";
import path from "path";
import type { VoxModelData } from "./vox.js";

type ImageData = { width: number; height: number; data: Uint8Array };

async function loadImage(filePath: string): Promise<ImageData> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    const { PNG } = await import("pngjs");
    const buf = fs.readFileSync(filePath);
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  } else if (ext === ".jpg" || ext === ".jpeg") {
    const jpeg = await import("jpeg-js");
    const buf = fs.readFileSync(filePath);
    const img = (jpeg as any).decode(buf, { useTArray: true });
    return { width: img.width, height: img.height, data: img.data };
  } else {
    throw new Error(`Unsupported image format: ${ext}`);
  }
}

export async function edgeDetectToVoxel(
  model: VoxModelData,
  imagePath: string,
  opts: { threshold?: number; downscale?: number; i?: number; z?: number }
) {
  const img = await loadImage(imagePath);
  const ds = Math.max(1, opts.downscale ?? 1);
  const width = Math.floor(img.width / ds);
  const height = Math.floor(img.height / ds);
  const threshold = opts.threshold ?? 64;
  const outZ = clamp(opts.z ?? 0, 0, model.sizeZ - 1);
  const gs = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, x * ds);
      const sy = Math.min(img.height - 1, y * ds);
      const idx = (sy * img.width + sx) * 4;
      const r = img.data[idx + 0] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      gs[y * width + x] = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
    }
  }
  const sobel = (x: number, y: number) => {
    const px = (xx: number, yy: number) => (gs[Math.max(0, Math.min(height - 1, yy)) * width + Math.max(0, Math.min(width - 1, xx))] ?? 0);
    const gx = -px(x - 1, y - 1) - 2 * px(x - 1, y) - px(x - 1, y + 1) + px(x + 1, y - 1) + 2 * px(x + 1, y) + px(x + 1, y + 1);
    const gy = -px(x - 1, y - 1) - 2 * px(x, y - 1) - px(x + 1, y - 1) + px(x - 1, y + 1) + 2 * px(x, y + 1) + px(x + 1, y + 1);
    const mag = Math.min(255, Math.abs(gx) + Math.abs(gy));
    return mag;
  };
  const colorIndex = Math.max(1, Math.min(255, opts.i ?? 250));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = sobel(x, y);
      if (m >= threshold) {
        const vx = clamp(x, 0, model.sizeX - 1);
        const vy = clamp(y, 0, model.sizeY - 1);
        model.voxels.push({ x: vx, y: vy, z: outZ, i: colorIndex });
      }
    }
  }
}

export async function depthMapToVoxel(
  model: VoxModelData,
  imagePath: string,
  opts: { invert?: boolean; downscale?: number; i?: number }
) {
  const img = await loadImage(imagePath);
  const ds = Math.max(1, opts.downscale ?? 1);
  const width = Math.floor(img.width / ds);
  const height = Math.floor(img.height / ds);
  const invert = !!opts.invert;
  const colorIndex = Math.max(1, Math.min(255, opts.i ?? 180));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, x * ds);
      const sy = Math.min(img.height - 1, y * ds);
      const idx = (sy * img.width + sx) * 4;
      const r = img.data[idx + 0] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      const lum = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
      const t = lum / 255;
      const z = Math.floor((invert ? 1 - t : t) * (model.sizeZ - 1));
      const vx = clamp(x, 0, model.sizeX - 1);
      const vy = clamp(y, 0, model.sizeY - 1);
      model.voxels.push({ x: vx, y: vy, z, i: colorIndex });
    }
  }
}

export async function multiViewToVoxel(
  model: VoxModelData,
  opts: {
    frontPath?: string;
    sidePath?: string;
    topPath?: string;
    downscale?: number;
    threshold?: number;
    colorFrom?: "top" | "front" | "side" | "none";
  }
) {
  const ds = Math.max(1, opts.downscale ?? 1);
  const threshold = opts.threshold ?? 16;

  const loadMask = async (p?: string) => {
    if (!p) return null as null | { w: number; h: number; data: Uint8Array; rgba: Uint8Array };
    const img = await loadImage(p);
    const w = Math.floor(img.width / ds), h = Math.floor(img.height / ds);
    const mask = new Uint8Array(w * h);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, x * ds);
        const sy = Math.min(img.height - 1, y * ds);
        const idx = (sy * img.width + sx) * 4;
        const r = img.data[idx + 0] ?? 0;
        const g = img.data[idx + 1] ?? 0;
        const b = img.data[idx + 2] ?? 0;
        const a = img.data[idx + 3] ?? 255;
        const lum = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
        mask[y * w + x] = a >= threshold || lum >= threshold ? 1 : 0;
        rgba.set([r, g, b, a], (y * w + x) * 4);
      }
    }
    return { w, h, data: mask, rgba };
  };

  const front = await loadMask(opts.frontPath);
  const side = await loadMask(opts.sidePath);
  const top = await loadMask(opts.topPath);

  if (!front && !side && !top) throw new Error("At least one of frontPath/sidePath/topPath is required");

  const colorFrom = opts.colorFrom ?? (top ? "top" : front ? "front" : side ? "side" : "none");

  for (let z = 0; z < model.sizeZ; z++) {
    for (let y = 0; y < model.sizeY; y++) {
      for (let x = 0; x < model.sizeX; x++) {
        let ok = true;
        if (front) {
          const fx = Math.min(front.w - 1, Math.floor((x / Math.max(1, model.sizeX - 1)) * (front.w - 1)));
          const fz = Math.min(front.h - 1, Math.floor((z / Math.max(1, model.sizeZ - 1)) * (front.h - 1)));
          if (front.data[fz * front.w + fx] === 0) ok = false;
        }
        if (!ok) continue;
        if (side) {
          const syx = Math.min(side.w - 1, Math.floor((y / Math.max(1, model.sizeY - 1)) * (side.w - 1)));
          const syz = Math.min(side.h - 1, Math.floor((z / Math.max(1, model.sizeZ - 1)) * (side.h - 1)));
          if (side.data[syz * side.w + syx] === 0) ok = false;
        }
        if (!ok) continue;
        if (top) {
          const tx = Math.min(top.w - 1, Math.floor((x / Math.max(1, model.sizeX - 1)) * (top.w - 1)));
          const ty = Math.min(top.h - 1, Math.floor((y / Math.max(1, model.sizeY - 1)) * (top.h - 1)));
          if (top.data[ty * top.w + tx] === 0) ok = false;
        }
        if (!ok) continue;

        let i = 200;
        const pick = (src: { w: number; h: number; rgba: Uint8Array } | null, u: number, v: number) => {
          if (!src) return 200;
          const px = Math.min(src!.w - 1, u);
          const py = Math.min(src!.h - 1, v);
          const base = (py * src!.w + px) * 4;
          const r = src!.rgba[base + 0] ?? 0;
          const g = src!.rgba[base + 1] ?? 0;
          const b = src!.rgba[base + 2] ?? 0;
          return rgbToPaletteIndex(r, g, b);
        };
        if (colorFrom === "top" && top) {
          const tx = Math.min(top.w - 1, Math.floor((x / Math.max(1, model.sizeX - 1)) * (top.w - 1)));
          const ty = Math.min(top.h - 1, Math.floor((y / Math.max(1, model.sizeY - 1)) * (top.h - 1)));
          i = pick(top, tx, ty);
        } else if (colorFrom === "front" && front) {
          const fx = Math.min(front.w - 1, Math.floor((x / Math.max(1, model.sizeX - 1)) * (front.w - 1)));
          const fz = Math.min(front.h - 1, Math.floor((z / Math.max(1, model.sizeZ - 1)) * (front.h - 1)));
          i = pick(front, fx, fz);
        } else if (colorFrom === "side" && side) {
          const syx = Math.min(side.w - 1, Math.floor((y / Math.max(1, model.sizeY - 1)) * (side.w - 1)));
          const syz = Math.min(side.h - 1, Math.floor((z / Math.max(1, model.sizeZ - 1)) * (side.h - 1)));
          i = pick(side, syx, syz);
        }

        model.voxels.push({ x, y, z, i });
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function rgbToPaletteIndex(r: number, g: number, b: number): number {
  const rq = Math.floor(r / 51);
  const gq = Math.floor(g / 51);
  const bq = Math.floor(b / 51);
  return Math.max(1, Math.min(255, 1 + rq * 36 + gq * 6 + bq));
}

export async function imageToVoxelColorized(
  model: VoxModelData,
  imagePath: string,
  opts: { mode?: "flat" | "heightmap"; maxZ?: number; threshold?: number; downscale?: number }
) {
  const img = await loadImage(imagePath);
  const ds = Math.max(1, opts.downscale ?? 1);
  const width = Math.floor(img.width / ds);
  const height = Math.floor(img.height / ds);
  const mode = opts.mode ?? "flat";
  const maxZ = Math.max(1, opts.maxZ ?? model.sizeZ);
  const threshold = opts.threshold ?? 16;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, x * ds);
      const sy = Math.min(img.height - 1, y * ds);
      const idx = (sy * img.width + sx) * 4;
      const r = img.data[idx + 0] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      const a = img.data[idx + 3] ?? 255;
      if (a < threshold) continue;
      const lum = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
      const i = rgbToPaletteIndex(r, g, b);
      const vx = clamp(x, 0, model.sizeX - 1);
      const vy = clamp(y, 0, model.sizeY - 1);
      if (mode === "flat") {
        model.voxels.push({ x: vx, y: vy, z: 0, i });
      } else {
        const h = Math.floor((lum / 255) * (maxZ - 1));
        for (let z = 0; z <= h && z < model.sizeZ; z++) model.voxels.push({ x: vx, y: vy, z, i });
      }
    }
  }
}

export async function silhouetteTo3D(
  model: VoxModelData,
  imagePath: string,
  opts: { thickness: number; threshold?: number; downscale?: number }
) {
  const img = await loadImage(imagePath);
  const ds = Math.max(1, opts.downscale ?? 1);
  const width = Math.floor(img.width / ds);
  const height = Math.floor(img.height / ds);
  const threshold = opts.threshold ?? 16;
  const thickness = Math.max(1, Math.min(model.sizeZ, opts.thickness));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, x * ds);
      const sy = Math.min(img.height - 1, y * ds);
      const idx = (sy * img.width + sx) * 4;
      const r = img.data[idx + 0] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      const a = img.data[idx + 3] ?? 255;
      const lum = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
      if (a < threshold && lum < threshold) continue;
      const i = rgbToPaletteIndex(r, g, b);
      const vx = clamp(x, 0, model.sizeX - 1);
      const vy = clamp(y, 0, model.sizeY - 1);
      for (let z = 0; z < thickness && z < model.sizeZ; z++) model.voxels.push({ x: vx, y: vy, z, i });
    }
  }
}

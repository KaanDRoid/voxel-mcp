import fs from "fs";
import { PNG } from "pngjs";
import type { VoxModelData } from "./vox.js";

export function setPaletteIndex(model: VoxModelData, index: number, rgba: number) {
  if (!model.palette) model.palette = new Uint32Array(256);
  model.palette[index & 255] = rgba >>> 0;
}

export function loadPaletteFromPng(model: VoxModelData, path: string) {
  const buf = fs.readFileSync(path);
  const png = PNG.sync.read(buf);
  if (png.width * png.height < 256) throw new Error("Palette PNG must have at least 256 pixels");
  if (!model.palette) model.palette = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i % png.width;
    const y = Math.floor(i / png.width);
    const idx = (y * png.width + x) * 4;
    const r = png.data[idx + 0] ?? 0;
    const g = png.data[idx + 1] ?? 0;
    const b = png.data[idx + 2] ?? 0;
    const a = png.data[idx + 3] ?? 255;
    const rgba = ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    model.palette[i] = rgba >>> 0;
  }
}

export function savePaletteToPng(model: VoxModelData, path: string) {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < 256; i++) {
    const x = i % 16;
    const y = Math.floor(i / 16);
    const idx = (y * 16 + x) * 4;
    const rgba = model.palette?.[i] ?? 0xff000000;
    const a = (rgba >>> 24) & 0xff;
    const r = (rgba >>> 16) & 0xff;
    const g = (rgba >>> 8) & 0xff;
    const b = rgba & 0xff;
    png.data[idx + 0] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = a;
  }
  const buf = PNG.sync.write(png);
  fs.writeFileSync(path, buf);
}

export function generatePalette(name: "sunset" | "forest" | "neon" | "grayscale" = "grayscale"): Uint32Array {
  const pal = new Uint32Array(256);
  const set = (i: number, r: number, g: number, b: number, a = 255) => { pal[i] = ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff); };
  pal[0] = 0x00000000;
  for (let i = 1; i < 256; i++) {
    let r = i, g = i, b = i;
    if (name === "sunset") { r = 200 + Math.floor(55 * (i / 255)); g = Math.floor(100 * (i / 255)); b = Math.floor(80 * (i / 255)); }
    else if (name === "forest") { r = Math.floor(40 * (i / 255)); g = 60 + Math.floor(195 * (i / 255)); b = Math.floor(40 * (i / 255)); }
    else if (name === "neon") { r = (i * 7) % 256; g = (i * 13) % 256; b = (i * 17) % 256; }
    set(i, Math.min(255, r), Math.min(255, g), Math.min(255, b));
  }
  return pal;
}

export async function extractPaletteFromImage(imagePath: string, count = 256): Promise<Uint32Array> {
  const { PNG } = await import("pngjs");
  const jpeg = await import("jpeg-js");
  const buf = fs.readFileSync(imagePath);
  const ext = imagePath.toLowerCase();
  let width = 0, height = 0, data: Uint8Array;
  if (ext.endsWith(".png")) {
    const png = PNG.sync.read(buf);
    width = png.width; height = png.height; data = png.data;
  } else {
    const img = (jpeg as any).decode(buf, { useTArray: true });
    width = img.width; height = img.height; data = img.data;
  }
  const bins = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4 + 0] ?? 0, g = data[i * 4 + 1] ?? 0, b = data[i * 4 + 2] ?? 0;
    const rq = Math.floor(r / 16), gq = Math.floor(g / 16), bq = Math.floor(b / 16);
    const key = (rq << 8) | (gq << 4) | bq;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const entries = Array.from(bins.entries()).sort((a, b) => b[1] - a[1]).slice(0, Math.min(256, count));
  const pal = new Uint32Array(256);
  pal[0] = 0x00000000;
  let idx = 1;
  for (const [key] of entries) {
    const rq = (key >> 8) & 0xf, gq = (key >> 4) & 0xf, bq = key & 0xf;
    const r = rq * 16 + 8, g = gq * 16 + 8, b = bq * 16 + 8;
    pal[idx++] = ((255 & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    if (idx >= 256) break;
  }
  // fill remaining with grayscale
  for (; idx < 256; idx++) {
    const v = idx;
    pal[idx] = ((255 & 0xff) << 24) | ((v & 0xff) << 16) | ((v & 0xff) << 8) | (v & 0xff);
  }
  return pal;
}

export function applyPaletteToModel(model: VoxModelData, palette: Uint32Array) {
  model.palette = new Uint32Array(palette);
}

export function blendPalettes(a: Uint32Array, b: Uint32Array, t: number): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const ca = a[i] ?? 0xff000000, cb = b[i] ?? 0xff000000;
    const ar = (ca >>> 16) & 0xff, ag = (ca >>> 8) & 0xff, ab = ca & 0xff, aa = (ca >>> 24) & 0xff;
    const br = (cb >>> 16) & 0xff, bg = (cb >>> 8) & 0xff, bb = cb & 0xff, ba = (cb >>> 24) & 0xff;
    const lr = Math.round(ar + (br - ar) * t), lg = Math.round(ag + (bg - ag) * t), lb = Math.round(ab + (bb - ab) * t), la = Math.round(aa + (ba - aa) * t);
    out[i] = ((la & 0xff) << 24) | ((lr & 0xff) << 16) | ((lg & 0xff) << 8) | (lb & 0xff);
  }
  return out;
}

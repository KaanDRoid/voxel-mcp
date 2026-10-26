import { PNG } from "pngjs";
import { readPngBounded } from "./png.js";
import { packRGBA, unpackRGBA } from "./color.js";
import { decodeVOXDocument, encodeVOXDocument, type VoxChunk } from "./vox.js";

/** Palette file formats. Model palettes are indexed by voxel index (entry 0 is the empty slot).
 * MagicaVoxel stores palette slot k for voxel index k+1, and slot 255 for index 0, in PNG, ACT and
 * VOX RGBA data alike; the converters below apply that shift in both directions. The slot order of the
 * ACT and palette-VOX files written by MagicaVoxel itself is unverified (same layout assumed). */
const slotToIndex = (slot: number) => (slot + 1) & 255;

export function paletteFromPng(buf: Buffer): Uint32Array {
  const png = readPngBounded(buf, { minPixels: 256, maxPixels: 256, maxInputBytes: 1024 * 1024 });
  if (png.width * png.height < 256) throw new Error("Palette PNG must contain at least 256 pixels (MagicaVoxel uses 256x1)");
  const out = new Uint32Array(256);
  for (let slot = 0; slot < 256; slot++) {
    const o = slot * 4;
    out[slotToIndex(slot)] = packRGBA(png.data[o]!, png.data[o + 1]!, png.data[o + 2]!, png.data[o + 3]!);
  }
  return out;
}

export function paletteToPng(palette: Uint32Array): Buffer {
  const png = new PNG({ width: 256, height: 1 });
  for (let slot = 0; slot < 256; slot++) {
    const c = unpackRGBA(palette[slotToIndex(slot)] ?? 0);
    png.data.set([c.r, c.g, c.b, c.a], slot * 4);
  }
  return PNG.sync.write(png);
}

/** Adobe Color Table: 256 RGB triplets, optionally followed by a big-endian color count and transparency index. */
export function paletteFromAct(buf: Buffer): Uint32Array {
  if (buf.length !== 768 && buf.length !== 772) throw new Error(`Invalid ACT file: expected 768 or 772 bytes, got ${buf.length}`);
  const out = new Uint32Array(256);
  for (let slot = 0; slot < 256; slot++) out[slotToIndex(slot)] = packRGBA(buf[slot * 3]!, buf[slot * 3 + 1]!, buf[slot * 3 + 2]!, 255);
  if (buf.length === 772) {
    const transparent = buf.readUInt16BE(770);
    if (transparent < 256) out[slotToIndex(transparent)] = (out[slotToIndex(transparent)]! & 0x00ffffff) >>> 0;
  }
  return out;
}

export function paletteToAct(palette: Uint32Array, opts: { trailer?: boolean } = {}): Buffer {
  const buf = Buffer.alloc(opts.trailer ? 772 : 768);
  for (let slot = 0; slot < 256; slot++) {
    const c = unpackRGBA(palette[slotToIndex(slot)] ?? 0);
    buf[slot * 3] = c.r; buf[slot * 3 + 1] = c.g; buf[slot * 3 + 2] = c.b;
  }
  if (opts.trailer) { buf.writeUInt16BE(256, 768); buf.writeUInt16BE(0xffff, 770); }
  return buf;
}

/** Reads the RGBA chunk of any VOX file (a palette-only file is a VOX file with an empty model). */
export function paletteFromVox(buf: Buffer): Uint32Array {
  const doc = decodeVOXDocument(buf);
  const rgba = doc.main.children.find(c => c.id === "RGBA");
  if (!rgba || rgba.content.length !== 1024) throw new Error("VOX file has no RGBA palette chunk");
  const out = new Uint32Array(256);
  for (let slot = 0; slot < 256; slot++) out[slotToIndex(slot)] = rgba.content.readUInt32LE(slot * 4);
  return out;
}

/** A minimal VOX file: one empty 1x1x1 model plus the RGBA chunk (layout of MagicaVoxel palette files is unverified). */
export function paletteToVox(palette: Uint32Array): Buffer {
  const size = Buffer.alloc(12); size.writeUInt32LE(1, 0); size.writeUInt32LE(1, 4); size.writeUInt32LE(1, 8);
  const rgba = Buffer.alloc(1024);
  for (let slot = 0; slot < 256; slot++) rgba.writeUInt32LE(palette[slotToIndex(slot)] ?? 0, slot * 4);
  const chunks: VoxChunk[] = [
    { id: "SIZE", content: size, children: [] },
    { id: "XYZI", content: Buffer.alloc(4), children: [] },
    { id: "RGBA", content: rgba, children: [] },
  ];
  return encodeVOXDocument({ version: 150, main: { id: "MAIN", content: Buffer.alloc(0), children: chunks } });
}

export type PaletteFileFormat = "png" | "act" | "vox";
export function paletteFormatFromPath(file: string): PaletteFileFormat {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "png" || ext === "act" || ext === "vox") return ext;
  throw new Error("Unsupported palette file extension: use .png, .act or .vox");
}

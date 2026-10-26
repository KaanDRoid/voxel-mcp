import { packRGBA, unpackRGBA } from "../color.js";
import { defaultPalette, type VoxModelData } from "../vox.js";
import { checkDims, checkVoxelBudget, indexColors } from "./common.js";

/** XRAW, the MagicaVoxel "RAW" export. Layout as publicly documented (the x-fastest voxel order and the
 * mapping of the file axes to MagicaVoxel axes are unverified against the application):
 *   "XRAW", u8 channelDataType (0 = unsigned int), u8 channelCount (4 = RGBA), u8 bitsPerChannel (8),
 *   u8 bitsPerIndex (8 = palette indices, 0 = direct RGBA per voxel), u32 width, height, depth,
 *   u32 paletteSize (256), then width*height*depth voxels (address = x + y*width + z*width*height),
 *   then paletteSize RGBA entries. Palette index 0 is the empty voxel. */
export function encodeXRAW(model: VoxModelData): Buffer {
  checkDims(model.sizeX, model.sizeY, model.sizeZ, "XRAW export");
  const { sizeX: sx, sizeY: sy, sizeZ: sz } = model;
  const palette = model.palette ?? defaultPalette();
  const volume = sx * sy * sz;
  const out = Buffer.alloc(24 + volume + 256 * 4);
  out.write("XRAW", 0, "latin1");
  out.set([0, 4, 8, 8], 4);
  out.writeUInt32LE(sx, 8); out.writeUInt32LE(sy, 12); out.writeUInt32LE(sz, 16); out.writeUInt32LE(256, 20);
  for (const v of model.voxels) {
    if (v.i < 1 || v.i > 255 || v.x < 0 || v.y < 0 || v.z < 0 || v.x >= sx || v.y >= sy || v.z >= sz) continue;
    out[24 + v.x + sx * (v.y + sy * v.z)] = v.i;
  }
  for (let i = 1; i < 256; i++) {
    const c = unpackRGBA(palette[i] ?? 0);
    out.set([c.r, c.g, c.b, c.a], 24 + volume + i * 4);
  }
  return out;
}

export function decodeXRAW(buf: Buffer): { model: VoxModelData; warnings: string[] } {
  if (buf.length < 24 || buf.toString("latin1", 0, 4) !== "XRAW") throw new Error("Not an XRAW file");
  const [dataType, channels, bitsPerChannel, bitsPerIndex] = [buf[4]!, buf[5]!, buf[6]!, buf[7]!];
  if (dataType !== 0 || channels !== 4 || bitsPerChannel !== 8) throw new Error("Unsupported XRAW color format: only 8-bit unsigned RGBA channels are supported");
  if (bitsPerIndex !== 8 && bitsPerIndex !== 0) throw new Error(`Unsupported XRAW bits per index ${bitsPerIndex}: only 8 (palette) and 0 (direct color) are supported`);
  const sx = buf.readUInt32LE(8), sy = buf.readUInt32LE(12), sz = buf.readUInt32LE(16), paletteSize = buf.readUInt32LE(20);
  checkDims(sx, sy, sz, "XRAW file");
  const volume = sx * sy * sz;
  checkVoxelBudget(volume, "XRAW file");
  if (paletteSize > 256) throw new Error("XRAW palette larger than 256 entries is not supported");
  const bytesPerVoxel = bitsPerIndex === 8 ? 1 : 4;
  const paletteBytes = bitsPerIndex === 8 ? paletteSize * 4 : 0;
  if (buf.length < 24 + volume * bytesPerVoxel + paletteBytes) throw new Error("XRAW file is truncated");
  const model: VoxModelData = { sizeX: sx, sizeY: sy, sizeZ: sz, voxels: [] };
  const warnings: string[] = [];
  if (bitsPerIndex === 8) {
    const palette = new Uint32Array(256), base = 24 + volume;
    for (let i = 1; i < paletteSize; i++) palette[i] = packRGBA(buf[base + i * 4]!, buf[base + i * 4 + 1]!, buf[base + i * 4 + 2]!, buf[base + i * 4 + 3]!);
    model.palette = palette;
    for (let i = 0; i < volume; i++) {
      const index = buf[24 + i]!;
      if (index === 0) continue;
      model.voxels.push({ x: i % sx, y: Math.floor(i / sx) % sy, z: Math.floor(i / (sx * sy)), i: index });
    }
    return { model, warnings };
  }
  const histogram = new Map<number, number>(), found: { i: number; key: number }[] = [];
  for (let i = 0; i < volume; i++) {
    const o = 24 + i * 4;
    if (buf[o + 3] === 0) continue;
    const key = (buf[o]! << 16) | (buf[o + 1]! << 8) | buf[o + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    found.push({ i, key });
  }
  const colors = indexColors(histogram, "XRAW import");
  model.palette = colors.palette;
  for (const f of found) {
    model.voxels.push({ x: f.i % sx, y: Math.floor(f.i / sx) % sy, z: Math.floor(f.i / (sx * sy)), i: colors.indexOf((f.key >>> 16) & 255, (f.key >>> 8) & 255, f.key & 255) });
  }
  return { model, warnings: colors.warnings.concat(warnings) };
}

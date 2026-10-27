import { packRGBA, unpackRGBA } from "../color.js";
import { defaultPalette, type VoxModelData } from "../vox.js";
import { checkDims, checkVoxelBudget } from "./common.js";

/** Slab6 / SLABSPRI "VOX" (not the MagicaVoxel VOX container), as documented by Ken Silverman:
 *   i32 xsiz, ysiz, zsiz; u8 voxel[xsiz][ysiz][zsiz] (z varies fastest; 255 = empty, other values are palette
 *   entries); u8 palette[256][3] with VGA 6-bit components (0..63).
 * The grid holds at most 256 x 256 x 255. Voxel index n (1..255) is stored as slab color n - 1, and the
 * Y/Z axes are flipped to match native MagicaVoxel Slab6 export; palette channels use its 6-bit truncation. */
export function encodeSlab6(model: VoxModelData): Buffer {
  const { sizeX: sx, sizeY: sy, sizeZ: sz } = model;
  if (sz > 255) throw new Error("Slab6 export: the Z size is limited to 255");
  checkDims(sx, sy, sz, "Slab6 export");
  const palette = model.palette ?? defaultPalette();
  const volume = sx * sy * sz;
  const out = Buffer.alloc(12 + volume + 768);
  out.writeInt32LE(sx, 0); out.writeInt32LE(sy, 4); out.writeInt32LE(sz, 8);
  out.fill(255, 12, 12 + volume);
  for (const v of model.voxels) {
    if (v.i < 1 || v.i > 255 || v.x < 0 || v.y < 0 || v.z < 0 || v.x >= sx || v.y >= sy || v.z >= sz) continue;
    out[12 + (v.x * sy + (sy - 1 - v.y)) * sz + (sz - 1 - v.z)] = v.i - 1;
  }
  for (let n = 1; n < 256; n++) {
    const c = unpackRGBA(palette[n] ?? 0);
    out.set([c.r >> 2, c.g >> 2, c.b >> 2], 12 + volume + (n - 1) * 3);
  }
  return out;
}

export function decodeSlab6(buf: Buffer): { model: VoxModelData; warnings: string[] } {
  if (buf.length < 12) throw new Error("Not a Slab6 VOX file (too short)");
  const sx = buf.readInt32LE(0), sy = buf.readInt32LE(4), sz = buf.readInt32LE(8);
  if (sz > 255) throw new Error("Slab6 VOX: the Z size is limited to 255");
  checkDims(sx, sy, sz, "Slab6 VOX file");
  const volume = sx * sy * sz;
  checkVoxelBudget(volume, "Slab6 VOX file");
  if (buf.length !== 12 + volume + 768) throw new Error("Slab6 VOX size mismatch: the file length does not match the header dimensions (truncated or not a Slab6 file)");
  const palette = new Uint32Array(256);
  const expand = (v: number) => ((v & 63) << 2) | ((v & 63) >> 4);
  for (let n = 1; n < 256; n++) {
    const o = 12 + volume + (n - 1) * 3;
    palette[n] = packRGBA(expand(buf[o]!), expand(buf[o + 1]!), expand(buf[o + 2]!), 255);
  }
  const model: VoxModelData = { sizeX: sx, sizeY: sy, sizeZ: sz, voxels: [], palette };
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const value = buf[12 + (x * sy + y) * sz + z]!;
    if (value === 255) continue;
    model.voxels.push({ x, y: sy - 1 - y, z: sz - 1 - z, i: value + 1 });
  }
  return { model, warnings: [] };
}

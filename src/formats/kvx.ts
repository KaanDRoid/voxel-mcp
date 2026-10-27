import { unpackRGBA } from '../color.js';
import { defaultPalette, type VoxModelData } from '../vox.js';
import { checkDims, indexColors } from './common.js';

const MAX_BYTES = 64 * 1024 * 1024;
// Deliberately stricter than the shared VOX budget: includes stored cells in every mip.
const MAX_VOXELS = 2_000_000;
const MAX_I32 = 0x7fffffff;
type Pivot = [number, number, number];

function voxelBudget(count: number): void {
  if (count > MAX_VOXELS) throw new Error('KVX: voxel count exceeds the supported limit (2,000,000)');
}
function dimensions(sx: number, sy: number, sz: number): void {
  checkDims(sx, sy, sz, 'KVX');
  if (sz > 255) throw new Error('KVX: Z dimension must be at most 255');
}
function fixedPivot(pivot: Pivot, sz: number): Pivot {
  const native: Pivot = [pivot[0] * 256, pivot[1] * 256, sz * 256 - pivot[2] * 256];
  for (const n of native) if (!Number.isInteger(n) || n < -0x80000000 || n > MAX_I32) {
    throw new Error('KVX: pivot must be exactly representable in signed int32 fixed8 (including transformed Z)');
  }
  return native;
}

/** Ken Silverman KVX, independently implemented from the format description and save/load behavior.
 * X/Y are unchanged; cell Z is sizeZ - 1 - nativeZ. Pivots use MODEL Z-up grid boundary coordinates
 * (cell centers lie at n + 0.5), so native pivot Z = sizeZ - model pivot Z, NOT sizeZ - 1 - pivot Z.
 * Defaults are the grid center; signed fractional pivots must be exact multiples of 1/256.
 * Writes one mip and ALL occupied cells, including internal cells with zero exposure. Slabs split on
 * gaps or six-face mask changes. Indices 1..255 map to file slots 0..254; slot 255 is unused on export.
 * RGB is truncated to six bits/channel and alpha is discarded: these are lossy format limitations.
 * Native viewers' axes relative to their camera are not asserted by this interchange convention. */
export function encodeKVX(model: VoxModelData, options?: { pivot?: Pivot }): Buffer {
  const { sizeX: sx, sizeY: sy, sizeZ: sz } = model;
  dimensions(sx, sy, sz);
  voxelBudget(model.voxels.length);
  const volume = sx * sy * sz;
  if (model.voxels.length > volume) throw new Error('KVX: voxel count exceeds model volume');
  if (model.palette && model.palette.length !== 256) throw new Error('KVX: palette must contain 256 entries');
  const pivot = fixedPivot(options?.pivot ?? [sx / 2, sy / 2, sz / 2], sz);
  const grid = new Uint8Array(volume);
  for (const v of model.voxels) {
    if (!Number.isInteger(v.x) || !Number.isInteger(v.y) || !Number.isInteger(v.z) ||
        v.x < 0 || v.x >= sx || v.y < 0 || v.y >= sy || v.z < 0 || v.z >= sz) {
      throw new Error('KVX: voxel coordinate outside model');
    }
    if (!Number.isInteger(v.i) || v.i < 1 || v.i > 255) throw new Error('KVX: voxel palette index must be 1..255');
    const key = (v.x * sy + v.y) * sz + sz - 1 - v.z;
    if (grid[key]) throw new Error('KVX: duplicate voxel coordinate');
    grid[key] = v.i;
  }
  const tables = (sx + 1) * 4 + sx * (sy + 1) * 2;
  const mask = (x: number, y: number, z: number, k: number): number =>
    (x === 0 || !grid[k - sy * sz] ? 1 : 0) |
    (x === sx - 1 || !grid[k + sy * sz] ? 2 : 0) |
    (y === 0 || !grid[k - sz] ? 4 : 0) |
    (y === sy - 1 || !grid[k + sz] ? 8 : 0) |
    (z === 0 || !grid[k - 1] ? 16 : 0) |
    (z === sz - 1 || !grid[k + 1] ? 32 : 0);
  // Sizing pass rejects unrepresentable relative offsets before allocating the output buffer.
  const slabs = (out?: Buffer): number => {
    let offset = tables;
    for (let x = 0; x < sx; x++) {
      const xstart = offset;
      out?.writeInt32LE(xstart, 28 + x * 4);
      for (let y = 0; y < sy; y++) {
        out?.writeUInt16LE(offset - xstart, 28 + (sx + 1) * 4 + (x * (sy + 1) + y) * 2);
        const base = (x * sy + y) * sz;
        let z = 0;
        while (z < sz) {
          if (!grid[base + z]) { z++; continue; }
          const start = z, vis = mask(x, y, z, base + z);
          z++;
          while (z < sz && grid[base + z] && mask(x, y, z, base + z) === vis) z++;
          if (out) {
            const p = 28 + offset;
            out[p] = start; out[p + 1] = z - start; out[p + 2] = vis;
            for (let i = start; i < z; i++) out[p + 3 + i - start] = grid[base + i]! - 1;
          }
          offset += 3 + z - start;
        }
        if (offset - xstart > 65535) throw new Error('KVX: x-column relative xy offset exceeds u16 (65535)');
      }
      out?.writeUInt16LE(offset - xstart, 28 + (sx + 1) * 4 + (x * (sy + 1) + sy) * 2);
    }
    out?.writeInt32LE(offset, 28 + sx * 4);
    if (24 + offset > MAX_I32 || 28 + offset + 768 > MAX_BYTES) throw new Error('KVX: block size exceeds supported limit');
    return offset;
  };
  const end = slabs();
  const out = Buffer.alloc(28 + end + 768);
  [24 + end, sx, sy, sz, ...pivot].forEach((n, i) => out.writeInt32LE(n, i * 4));
  slabs(out);
  const palette = model.palette ?? defaultPalette();
  for (let n = 1; n <= 255; n++) {
    const c = unpackRGBA(palette[n]!);
    out.set([c.r >> 2, c.g >> 2, c.b >> 2], 28 + end + (n - 1) * 3);
  }
  return out;
}

interface Level {
  origin: number;
  end: number;
  sx: number;
  sy: number;
  sz: number;
  nativePivot: Pivot;
}

/** Reads every provided mip (at most five), returns only the highest resolution's stored voxels.
 * Validation and cumulative stored-voxel budgets precede any voxel-object materialization.
 * Native KVX normally omits interiors; no implicit occupancy or color reconstruction is attempted.
 * Six-bit RGB expands by bit replication; alpha becomes opaque. All 256 file slots are valid,
 * with indexColors reducing >255 used RGB colors and reporting its quantization warning. */
export function decodeKVX(buf: Buffer): { model: VoxModelData; warnings: string[]; pivot: Pivot; mipLevels: number } {
  if (buf.length > MAX_BYTES) throw new Error('KVX: input exceeds 64 MiB limit');
  if (buf.length < 28 + 12 + 768) throw new Error('KVX: truncated file');
  const paletteStart = buf.length - 768;
  for (let p = paletteStart; p < buf.length; p++) if (buf[p]! > 63) throw new Error('KVX: palette component exceeds six-bit range');
  const levels: Level[] = [];
  let position = 0, stored = 0;

  // No per-slab records, source-controlled allocation sizes or inferred solid-volume counts.
  const walk = (l: Level, visit?: (x: number, y: number, z: number, slot: number) => void): void => {
    const { origin, end, sx, sy, sz } = l;
    const tableBytes = (sx + 1) * 4 + sx * (sy + 1) * 2;
    if (origin + tableBytes > end) throw new Error('KVX: truncated offset dictionaries');
    let previousX = tableBytes;
    for (let x = 0; x < sx; x++) {
      const xstart = buf.readInt32LE(origin + x * 4);
      const nextX = buf.readInt32LE(origin + (x + 1) * 4);
      if (xstart !== previousX || nextX < xstart || origin + nextX > end || nextX - xstart > 65535) {
        throw new Error('KVX: invalid xstart offset dictionary');
      }
      const xy = origin + (sx + 1) * 4 + x * (sy + 1) * 2;
      if (buf.readUInt16LE(xy) !== 0 || buf.readUInt16LE(xy + sy * 2) !== nextX - xstart) {
        throw new Error('KVX: inconsistent xy offset dictionary endpoints');
      }
      for (let y = 0; y < sy; y++) {
        const start = buf.readUInt16LE(xy + y * 2), stop = buf.readUInt16LE(xy + (y + 1) * 2);
        if (stop < start || stop > nextX - xstart) throw new Error('KVX: descending or out-of-range xy offset');
        let p = origin + xstart + start;
        const columnEnd = origin + xstart + stop;
        let previousZ = 0;
        while (p < columnEnd) {
          if (columnEnd - p < 3) throw new Error('KVX: truncated slab header');
          const z = buf[p]!, length = buf[p + 1]!, vis = buf[p + 2]!;
          if (!length || z < previousZ || z + length > sz || p + 3 + length > columnEnd) {
            throw new Error('KVX: invalid slab bounds, overlap or truncation');
          }
          if (vis & 0xc0) throw new Error('KVX: invalid slab visibility bits');
          if (!visit) { stored += length; voxelBudget(stored); }
          else for (let i = 0; i < length; i++) visit(x, y, z + i, buf[p + 3 + i]!);
          previousZ = z + length;
          p += 3 + length;
        }
      }
      previousX = nextX;
    }
    if (origin + previousX !== end) throw new Error('KVX: trailing slab bytes or invalid terminal xstart');
  };

  while (position < paletteStart) {
    if (levels.length === 5) throw new Error('KVX: at most five mip levels are supported');
    if (paletteStart - position < 28) throw new Error('KVX: truncated mip header or trailing bytes');
    const bytes = buf.readInt32LE(position);
    if (bytes < 24 || bytes > paletteStart - position - 4) throw new Error('KVX: invalid block size or truncated mip');
    const sx = buf.readInt32LE(position + 4), sy = buf.readInt32LE(position + 8), sz = buf.readInt32LE(position + 12);
    dimensions(sx, sy, sz);
    const nativePivot: Pivot = [buf.readInt32LE(position + 16), buf.readInt32LE(position + 20), buf.readInt32LE(position + 24)];
    const previous = levels.at(-1);
    if (previous) {
      if (sx !== Math.ceil(previous.sx / 2) || sy !== Math.ceil(previous.sy / 2) || sz !== Math.ceil(previous.sz / 2)) {
        throw new Error('KVX: mip dimensions must be ceil-halved');
      }
      if (nativePivot.some((n, i) => n !== Math.floor(previous.nativePivot[i]! / 2))) throw new Error('KVX: inconsistent mip pivot');
    }
    const l: Level = { origin: position + 28, end: position + 4 + bytes, sx, sy, sz, nativePivot };
    walk(l);
    levels.push(l);
    position = l.end;
  }
  const top = levels[0];
  if (!top || position !== paletteStart) throw new Error('KVX: missing mip or trailing bytes');
  const expand = (v: number) => (v << 2) | (v >> 4);
  const rgb = (slot: number): [number, number, number] => {
    const p = paletteStart + slot * 3;
    return [expand(buf[p]!), expand(buf[p + 1]!), expand(buf[p + 2]!)];
  };
  const histogram = new Map<number, number>();
  walk(top, (_x, _y, _z, slot) => {
    const [r, g, b] = rgb(slot), key = (r << 16) | (g << 8) | b;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  });
  const indexed = indexColors(histogram, 'KVX');
  const indices = new Uint8Array(256);
  for (let slot = 0; slot < 256; slot++) {
    const [r, g, b] = rgb(slot);
    if (histogram.has((r << 16) | (g << 8) | b)) indices[slot] = indexed.indexOf(r, g, b);
  }
  const model: VoxModelData = { sizeX: top.sx, sizeY: top.sy, sizeZ: top.sz, palette: indexed.palette, voxels: [] };
  walk(top, (x, y, z, slot) => model.voxels.push({ x, y, z: top.sz - 1 - z, i: indices[slot]! }));
  return {
    model,
    warnings: ['KVX: implicit interior occupancy and color are not recovered; only explicitly stored voxels are imported.', ...indexed.warnings],
    pivot: [top.nativePivot[0] / 256, top.nativePivot[1] / 256, top.sz - top.nativePivot[2] / 256],
    mipLevels: levels.length,
  };
}

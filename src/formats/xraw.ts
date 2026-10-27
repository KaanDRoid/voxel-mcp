
import { type VoxModelData } from '../vox.js';
import { checkDims, indexColors } from './common.js';
import { decodeRaw, encodeRaw } from './raw.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OCCUPIED = 2_000_000;
function countLimit(count: number): void {
  if (count > MAX_OCCUPIED) throw new Error('XRAW voxel budget exceeds 2000000 occupied cells');
}

/** XRAW unsigned RGBA8: explicit indexed8 or direct rgba8, x-fastest, index/alpha zero is empty. */
export function encodeXRAW(model: VoxModelData, options: { encoding?: 'indexed8' | 'rgba8' | undefined } = {}): Buffer {
  const encoding = options.encoding ?? 'indexed8';
  if (encoding !== 'indexed8' && encoding !== 'rgba8') throw new Error('Unsupported XRAW encoding');
  const raw = encodeRaw(model, { encoding });
  const paletteBytes = encoding === 'indexed8' ? 1024 : 0;
  if (24 + raw.data.length + paletteBytes > MAX_BYTES) throw new Error('XRAW output exceeds 64 MiB');
  const out = Buffer.alloc(24 + raw.data.length + paletteBytes);
  out.write('XRAW', 0, 'latin1'); out.set([0, 4, 8, encoding === 'indexed8' ? 8 : 0], 4);
  out.writeUInt32LE(model.sizeX, 8); out.writeUInt32LE(model.sizeY, 12); out.writeUInt32LE(model.sizeZ, 16);
  out.writeUInt32LE(encoding === 'indexed8' ? 256 : 0, 20); raw.data.copy(out, 24);
  if (encoding === 'indexed8') for (let i = 1; i < 256; i++) out.writeUInt32LE(raw.metadata.palette![i]!, 24 + raw.data.length + i * 4);
  return out;
}

export function decodeXRAW(buf: Buffer): { model: VoxModelData; warnings: string[] } {
  if (buf.length > MAX_BYTES) throw new Error('XRAW input exceeds 64 MiB');
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'XRAW') throw new Error('Not an XRAW file');
  const dataType = buf[4]!, channels = buf[5]!, bitsPerChannel = buf[6]!, bitsPerIndex = buf[7]!;
  if (dataType !== 0 || channels !== 4 || bitsPerChannel !== 8) throw new Error('Unsupported XRAW color format: only 8-bit unsigned RGBA channels are supported');
  if (bitsPerIndex !== 8 && bitsPerIndex !== 0) throw new Error('Unsupported XRAW bits per index: only indexed8 and direct color are supported');
  const sx = buf.readUInt32LE(8), sy = buf.readUInt32LE(12), sz = buf.readUInt32LE(16), paletteSize = buf.readUInt32LE(20);
  checkDims(sx, sy, sz, 'XRAW');
  if (paletteSize > 256) throw new Error('XRAW palette larger than 256 entries is not supported');
  const volume = sx * sy * sz;
  const expected = 24 + volume * (bitsPerIndex === 8 ? 1 : 4) + (bitsPerIndex === 8 ? paletteSize * 4 : 0);
  if (buf.length !== expected) throw new Error('XRAW length mismatch: truncated or trailing bytes');
  const dimensions = { sizeX: sx, sizeY: sy, sizeZ: sz };
  if (bitsPerIndex === 8) {
    let count = 0;
    for (let i = 0; i < volume; i++) {
      const index = buf[24 + i]!;
      if (index === 0) continue;
      if (index >= paletteSize) throw new Error('XRAW palette index references a missing entry');
      countLimit(++count);
    }
    const palette = new Uint32Array(256), base = 24 + volume;
    for (let i = 1; i < paletteSize; i++) palette[i] = buf.readUInt32LE(base + i * 4);
    return decodeRaw(buf.subarray(24, 24 + volume), { ...dimensions, encoding: 'indexed8', palette });
  }
  let count = 0;
  const rgba = new Set<number>();
  for (let i = 0; i < volume; i++) {
    const o = 24 + i * 4; if (buf[o + 3] === 0) continue;
    countLimit(++count);
    if (rgba.size <= 255) rgba.add(buf.readUInt32LE(o));
  }
  if (rgba.size <= 255) return decodeRaw(buf.subarray(24), { ...dimensions, encoding: 'rgba8' });
  // Quantize true-color input without retaining a second object per occupied cell.
  const histogram = new Map<number, number>(); let partialAlpha = false;
  for (let i = 0; i < volume; i++) {
    const o = 24 + i * 4; if (buf[o + 3] === 0) continue;
    const key = (buf[o]! << 16) | (buf[o + 1]! << 8) | buf[o + 2]!;
    if (!histogram.has(key) && histogram.size >= 65536) throw new Error('XRAW high-color allocation budget exceeded; quantize the source explicitly');
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    partialAlpha ||= buf[o + 3] !== 255;
  }
  const colors = indexColors(histogram, 'XRAW import');
  const model: VoxModelData = { ...dimensions, palette: colors.palette, voxels: [] };
  for (let i = 0; i < volume; i++) {
    const o = 24 + i * 4; if (buf[o + 3] === 0) continue;
    model.voxels.push({ x: i % sx, y: Math.floor(i / sx) % sy, z: Math.floor(i / (sx * sy)), i: colors.indexOf(buf[o]!, buf[o + 1]!, buf[o + 2]!) });
  }
  const warnings = [...colors.warnings];
  if (partialAlpha) warnings.push('XRAW: more than 255 occupied RGBA colors were reduced to an opaque RGB palette; partial alpha was discarded');
  return { model, warnings };
}

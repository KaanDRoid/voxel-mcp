import { defaultPalette, type VoxModelData } from '../vox.js';
import { checkDims, checkVoxelBudget } from './common.js';

export type RawEncoding = 'rgba8' | 'rgb8' | 'indexed8';
export type RawOrder = 'x-fastest' | 'z-fastest';
export interface RawMetadata {
  sizeX: number; sizeY: number; sizeZ: number;
  encoding: RawEncoding;
  order?: RawOrder;
  /** RGB sentinel as 0xRRGGBB; absent means every RGB sample is occupied. */
  emptyColor?: number;
  palette?: ArrayLike<number>;
}
const MAX_BYTES = 64 * 1024 * 1024;
function checkBudget(count: number, what: string): void {
  checkVoxelBudget(count, what);
  if (count > 2_000_000) throw new Error(`${what}: voxel budget exceeds 2000000`);
}
function parameters(options: RawMetadata) {
  checkDims(options.sizeX, options.sizeY, options.sizeZ, 'RAW');
  if (!['rgba8', 'rgb8', 'indexed8'].includes(options.encoding)) throw new Error('Unsupported RAW encoding');
  const order = options.order ?? 'x-fastest';
  if (!['x-fastest', 'z-fastest'].includes(order)) throw new Error('Unsupported RAW voxel order');
  if (options.emptyColor !== undefined && (!Number.isInteger(options.emptyColor) || options.emptyColor < 0 || options.emptyColor > 0xffffff || options.encoding !== 'rgb8')) throw new Error('emptyColor is an RGB8-only 0xRRGGBB value');
  const channels = options.encoding === 'rgba8' ? 4 : options.encoding === 'rgb8' ? 3 : 1;
  const volume = options.sizeX * options.sizeY * options.sizeZ, bytes = volume * channels;
  if (bytes > MAX_BYTES) throw new Error('RAW input/output exceeds 64 MiB');
  return { order, channels, volume, bytes };
}
function sourcePalette(value?: ArrayLike<number>): Uint32Array {
  if (value === undefined) return defaultPalette();
  if (value.length !== 256) throw new Error('RAW palette requires exactly 256 RGBA values');
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const n = value[i];
    if (!Number.isInteger(n) || n! < 0 || n! > 0xffffffff) throw new Error('Invalid RAW palette entry');
    out[i] = n!;
  }
  return out;
}
function position(x: number, y: number, z: number, options: RawMetadata, order: RawOrder) {
  return order === 'x-fastest' ? x + options.sizeX * (y + options.sizeY * z) : z + options.sizeZ * (y + options.sizeY * x);
}
function coordinates(p: number, options: RawMetadata, order: RawOrder) {
  return order === 'x-fastest'
    ? { x: p % options.sizeX, y: Math.floor(p / options.sizeX) % options.sizeY, z: Math.floor(p / (options.sizeX * options.sizeY)) }
    : { x: Math.floor(p / (options.sizeZ * options.sizeY)), y: Math.floor(p / options.sizeZ) % options.sizeY, z: p % options.sizeZ };
}

/** Headerless data is never guessed: dimensions, encoding and ordering are explicit metadata. */
export function encodeRaw(model: VoxModelData, options: { encoding: RawEncoding; order?: RawOrder; emptyColor?: number }): { data: Buffer; metadata: RawMetadata; warnings: string[] } {
  const metadata: RawMetadata = { sizeX: model.sizeX, sizeY: model.sizeY, sizeZ: model.sizeZ, ...options, order: options.order ?? 'x-fastest' };
  const p = parameters(metadata);
  checkBudget(model.voxels.length, 'RAW export');
  const palette = sourcePalette(model.palette);
  const occupied = new Uint8Array(p.volume);
  const usedRgb = new Set<number>();
  let alphaLost = false;
  for (const v of model.voxels) {
    if (![v.x, v.y, v.z, v.i].every(Number.isInteger) || v.x < 0 || v.y < 0 || v.z < 0 || v.x >= model.sizeX || v.y >= model.sizeY || v.z >= model.sizeZ || v.i < 1 || v.i > 255) throw new Error('Invalid RAW source voxel');
    const index = position(v.x, v.y, v.z, metadata, p.order);
    if (occupied[index]) throw new Error('Duplicate RAW source voxel');
    occupied[index] = 1;
    const color = palette[v.i]!;
    if (metadata.encoding === 'rgba8' && color >>> 24 === 0) throw new Error('RGBA8 cannot distinguish an occupied zero-alpha voxel from empty space');
    usedRgb.add(((color & 255) << 16) | (((color >>> 8) & 255) << 8) | ((color >>> 16) & 255));
    if (color >>> 24 !== 255) alphaLost = true;
  }
  if (metadata.encoding === 'rgb8' && metadata.emptyColor !== undefined && usedRgb.has(metadata.emptyColor)) throw new Error('RAW emptyColor collides with an occupied RGB color');
  if (metadata.encoding === 'rgb8' && model.voxels.length < p.volume) {
    let empty = metadata.emptyColor ?? 0;
    if (metadata.emptyColor === undefined) while (usedRgb.has(empty)) empty++;
    if (usedRgb.has(empty)) throw new Error('RAW emptyColor collides with an occupied RGB color');
    metadata.emptyColor = empty;
  }
  if (metadata.encoding === 'indexed8') metadata.palette = Array.from(palette);
  const data = Buffer.alloc(p.bytes);
  if (metadata.encoding === 'rgb8' && metadata.emptyColor !== undefined) {
    const rgb = metadata.emptyColor;
    for (let i = 0; i < data.length; i += 3) { data[i] = rgb >>> 16; data[i + 1] = (rgb >>> 8) & 255; data[i + 2] = rgb & 255; }
  }
  for (const v of model.voxels) {
    const offset = position(v.x, v.y, v.z, metadata, p.order) * p.channels;
    if (metadata.encoding === 'indexed8') { data[offset] = v.i; continue; }
    const color = palette[v.i]!;
    data[offset] = color & 255; data[offset + 1] = (color >>> 8) & 255; data[offset + 2] = (color >>> 16) & 255;
    if (metadata.encoding === 'rgba8') data[offset + 3] = color >>> 24;
  }
  return { data, metadata, warnings: metadata.encoding === 'rgb8' && alphaLost ? ['RGB8 does not store alpha; occupied colors were made opaque'] : [] };
}

export function decodeRaw(data: Buffer, options: RawMetadata): { model: VoxModelData; warnings: string[] } {
  const p = parameters(options);
  if (data.length !== p.bytes) throw new Error('RAW file length does not match the explicit dimensions and encoding');
  const palette = options.encoding === 'indexed8' ? sourcePalette(options.palette) : new Uint32Array(256);
  const colors = new Map<number, number>();
  let count = 0;
  const sample = (i: number): number => {
    const offset = i * p.channels;
    if (options.encoding === 'indexed8') return data[offset]!;
    const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
    if (options.encoding === 'rgba8' && data[offset + 3] === 0) return 0;
    if (options.encoding === 'rgb8' && options.emptyColor === ((r << 16) | (g << 8) | b)) return 0;
    return (r | (g << 8) | (b << 16) | ((options.encoding === 'rgba8' ? data[offset + 3]! : 255) << 24)) >>> 0;
  };
  // Preflight occupancy and distinct RGBA values before allocating any voxel objects.
  for (let i = 0; i < p.volume; i++) {
    const value = sample(i); if (value === 0) continue;
    count++; checkBudget(count, 'RAW import');
    if (options.encoding !== 'indexed8' && !colors.has(value)) {
      if (colors.size >= 255) throw new Error('RAW import exceeds 255 distinct occupied RGBA colors; quantize the source explicitly');
      const index = colors.size + 1; colors.set(value, index); palette[index] = value;
    }
  }
  const model: VoxModelData = { sizeX: options.sizeX, sizeY: options.sizeY, sizeZ: options.sizeZ, palette, voxels: [] };
  for (let i = 0; i < p.volume; i++) {
    const value = sample(i); if (value === 0) continue;
    model.voxels.push({ ...coordinates(i, options, p.order), i: options.encoding === 'indexed8' ? value : colors.get(value)! });
  }
  return { model, warnings: [] };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { packRGBA, unpackRGBA } from '../src/color.js';
import type { VoxModelData } from '../src/vox.js';
import { decodeKVX, encodeKVX } from '../src/formats/kvx.js';

// Independently constructed fixtures: offsets are relative to byte 28 (table origin).
function level(sx: number, sy: number, sz: number, columns: readonly number[][], pivot = [sx * 128, sy * 128, sz * 128]): Buffer {
  const tables = (sx + 1) * 4 + sx * (sy + 1) * 2;
  const data = columns.reduce((n, c) => n + c.length, 0);
  const b = Buffer.alloc(28 + tables + data);
  [24 + tables + data, sx, sy, sz, ...pivot].forEach((v, i) => b.writeInt32LE(v, i * 4));
  let offset = tables;
  for (let x = 0; x < sx; x++) {
    b.writeInt32LE(offset, 28 + x * 4);
    let relative = 0;
    for (let y = 0; y < sy; y++) {
      b.writeUInt16LE(relative, 28 + (sx + 1) * 4 + (x * (sy + 1) + y) * 2);
      const c = columns[x * sy + y] ?? [];
      b.set(c, 28 + offset + relative); relative += c.length;
    }
    b.writeUInt16LE(relative, 28 + (sx + 1) * 4 + (x * (sy + 1) + sy) * 2);
    offset += relative;
  }
  b.writeInt32LE(offset, 28 + sx * 4);
  return b;
}
function file(...levels: Buffer[]): Buffer {
  const p = Buffer.alloc(768);
  p.set([63, 0, 0], 0); p.set([0, 63, 0], 3); p.set([0, 0, 63], 765);
  return Buffer.concat([...levels, p]);
}
function sample(): VoxModelData {
  const palette = new Uint32Array(256);
  palette[1] = packRGBA(255, 0, 0); palette[2] = packRGBA(0, 255, 0);
  palette[255] = packRGBA(10, 20, 30, 7);
  return { sizeX: 2, sizeY: 3, sizeZ: 4, palette, voxels: [
    { x: 1, y: 2, z: 0, i: 1 }, { x: 0, y: 0, z: 3, i: 2 }, { x: 0, y: 1, z: 1, i: 255 },
  ] };
}
const occupied = (m: VoxModelData) => m.voxels.map(v => `${v.x},${v.y},${v.z}`).sort();
const single = () => file(level(1, 1, 3, [[0, 1, 63, 0, 2, 1, 63, 255]]));
function noVoxelPush(fn: () => unknown, expected: RegExp): void {
  const original = Array.prototype.push;
  let appended = 0;
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    if (items.some(v => v && typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v)) appended++;
    return Reflect.apply(original, this, items);
  };
  try { assert.throws(fn, expected); assert.equal(appended, 0, 'validation must precede voxel materialization'); }
  finally { Array.prototype.push = original; }
}

test('KVX decodes independent slabs, all color slots, Z flip, signed fractional boundary pivot and interior warning', () => {
  const b = single(); b.writeInt32LE(-320, 16); b.writeInt32LE(129, 20); b.writeInt32LE(-64, 24);
  const r = decodeKVX(b);
  assert.deepEqual(r.pivot, [-1.25, 129 / 256, 3.25]);
  assert.equal(r.mipLevels, 1);
  assert.deepEqual(occupied(r.model), ['0,0,0', '0,0,2']);
  assert.deepEqual(r.model.voxels.map(v => unpackRGBA(r.model.palette![v.i]!)), [
    { r: 255, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 255, a: 255 },
  ]);
  assert.ok(r.model.voxels.every(v => v.i > 0));
  assert.match(r.warnings.join(' '), /implicit interior.*(occupancy|color).*not recovered/i);
});

test('KVX encoder has exact independently specified bytes and n -> slot n-1 palette mapping', () => {
  const m = sample(); m.sizeX = 1; m.sizeY = 1; m.sizeZ = 3; m.voxels = [{ x: 0, y: 0, z: 0, i: 255 }];
  const b = encodeKVX(m, { pivot: [-1.25, 129 / 256, 3.25] });
  const expected = file(level(1, 1, 3, [[2, 1, 63, 254]], [-320, 129, -64]));
  expected.fill(0, expected.length - 768);
  expected.set([63, 0, 0, 0, 63, 0], expected.length - 768);
  expected.set([2, 5, 7], expected.length - 768 + 254 * 3);
  assert.deepEqual(b, expected);
});

test('KVX empty, singleton and asymmetric occupancy round trips; RGB six-bit precision and absent alpha', () => {
  for (const m of [sample(), { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] }, { sizeX: 256, sizeY: 256, sizeZ: 255, voxels: [{ x: 255, y: 255, z: 254, i: 1 }] }]) {
    const r = decodeKVX(encodeKVX(m));
    assert.deepEqual(occupied(r.model), occupied(m));
    assert.deepEqual([r.model.sizeX, r.model.sizeY, r.model.sizeZ], [m.sizeX, m.sizeY, m.sizeZ]);
    assert.deepEqual(r.pivot, [m.sizeX / 2, m.sizeY / 2, m.sizeZ / 2]);
  }
  const r = decodeKVX(encodeKVX(sample()));
  const v = r.model.voxels.find(v => v.x === 0 && v.y === 1)!;
  assert.deepEqual(unpackRGBA(r.model.palette![v.i]!), { r: 8, g: 20, b: 28, a: 255 });
});

test('KVX all occupied internal cells retained, correct six-face masks, split on mask changes, deterministic order', () => {
  const m: VoxModelData = { sizeX: 3, sizeY: 3, sizeZ: 3, voxels: [] };
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) m.voxels.push({ x, y, z, i: 1 });
  const b = encodeKVX(m);
  assert.deepEqual(b, encodeKVX({ ...m, voxels: m.voxels.slice().reverse() }));
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) {
    const p = 28 + b.readInt32LE(28 + x * 4) + b.readUInt16LE(28 + 16 + (x * 4 + y) * 2);
    const side = (x === 0 ? 1 : x === 2 ? 2 : 0) | (y === 0 ? 4 : y === 2 ? 8 : 0);
    assert.deepEqual([...b.subarray(p, p + 12)], [0, 1, side | 16, 0, 1, 1, side, 0, 2, 1, side | 32, 0]);
  }
  assert.deepEqual(occupied(decodeKVX(b).model), occupied(m));
});

test('KVX accepts aggregate native visibility and does not fill implicit interiors', () => {
  const r = decodeKVX(file(level(1, 1, 5, [[0, 1, 31, 0, 4, 1, 47, 1]])));
  assert.deepEqual(occupied(r.model), ['0,0,0', '0,0,4']);
  assert.equal(decodeKVX(file(level(1, 1, 3, [[0, 3, 63, 0, 1, 255]]))).model.voxels.length, 3);
});

test('KVX merges equal-mask runs across color changes, but splits on gaps and changed exposure', () => {
  const m: VoxModelData = { sizeX: 1, sizeY: 1, sizeZ: 7, voxels: [
    { x: 0, y: 0, z: 6, i: 1 }, { x: 0, y: 0, z: 5, i: 2 },
    { x: 0, y: 0, z: 4, i: 3 }, { x: 0, y: 0, z: 3, i: 4 },
    { x: 0, y: 0, z: 2, i: 5 }, { x: 0, y: 0, z: 0, i: 255 },
  ] };
  const b = encodeKVX(m);
  assert.deepEqual([...b.subarray(40, b.length - 768)], [
    0, 1, 31, 0, 1, 3, 15, 1, 2, 3, 4, 1, 47, 4, 6, 1, 63, 254,
  ]);
  assert.deepEqual(occupied(decodeKVX(b).model), occupied(m));
});

test('KVX returns highest-resolution voxels, not the lower mip occupancy or colors', () => {
  const columns = Array.from({ length: 9 }, () => [] as number[]);
  columns[0] = [0, 1, 31, 0]; columns[8] = [4, 1, 47, 255];
  const b = file(level(3, 3, 5, columns), level(2, 2, 3, [[1, 1, 63, 1], [], [], []], [192, 192, 320]));
  const r = decodeKVX(b);
  assert.equal(r.mipLevels, 2);
  assert.deepEqual(occupied(r.model), ['0,0,4', '2,2,0']);
  assert.deepEqual(r.model.voxels.map(v => unpackRGBA(r.model.palette![v.i]!)), [
    { r: 255, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 255, a: 255 },
  ]);
});

test('KVX decodes and validates up to five ceil-halved mip levels with native signed pivot scaling', () => {
  const levels = [17, 9, 5, 3, 2].map((n, i) => level(n, 1, 1, Array.from({ length: n }, () => []), [Math.floor(-257 / 2 ** i), 0, 0]));
  const r = decodeKVX(file(...levels));
  assert.equal(r.mipLevels, 5); assert.equal(r.model.sizeX, 17); assert.deepEqual(r.pivot, [-257 / 256, 0, 1]);
  assert.throws(() => decodeKVX(file(...levels, level(1, 1, 1, [[]], [-9, 0, 0]))), /mip|five|5/i);
  assert.throws(() => decodeKVX(file(level(3, 1, 1, [[], [], []]), level(1, 1, 1, [[]]))), /mip|dimension/i);
  assert.throws(() => decodeKVX(file(level(2, 1, 1, [[], []]), level(1, 1, 1, [[]], [999, 64, 64]))), /mip|pivot/i);
});

test('KVX handles 256 distinct used file colors through indexColors without index-zero occupancy', () => {
  const b = file(level(256, 1, 1, Array.from({ length: 256 }, (_, n) => [0, 1, 63, n])));
  for (let n = 0; n < 256; n++) b.set([n % 64, Math.floor(n / 64), 0], b.length - 768 + n * 3);
  const r = decodeKVX(b);
  assert.equal(r.model.voxels.length, 256);
  assert.ok(r.model.voxels.every(v => v.i >= 1 && v.i <= 255));
  assert.match(r.warnings.join(' '), /256 distinct colors reduced to 255/);
});

test('KVX validates dimensions, source indices, coordinates, duplicates and palettes rather than dropping cells', () => {
  const empty: VoxModelData = { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] };
  for (const dims of [[0, 1, 1], [257, 1, 1], [1, 257, 1], [1, 1, 256], [1, 1, 1.5]]) {
    assert.throws(() => encodeKVX({ ...empty, sizeX: dims[0]!, sizeY: dims[1]!, sizeZ: dims[2]! }), /dimension|255|256/i);
  }
  for (const v of [{ x: 0.5, y: 0, z: 0, i: 1 }, { x: 0, y: -1, z: 0, i: 1 }, { x: 0, y: 0, z: 1, i: 1 }, { x: 0, y: 0, z: 0, i: 0 }, { x: 0, y: 0, z: 0, i: 256 }, { x: 0, y: 0, z: 0, i: NaN }]) {
    assert.throws(() => encodeKVX({ ...empty, voxels: [v] }), /coordinate|index|voxel/i);
  }
  assert.throws(() => encodeKVX({ ...empty, voxels: [{ x: 0, y: 0, z: 0, i: 1 }, { x: 0, y: 0, z: 0, i: 2 }] }), /duplicate|volume/i);
  assert.throws(() => encodeKVX({ ...empty, palette: new Uint32Array(255) }), /palette/i);
});

test('KVX pivot requires finite signed fixed8 values without rounding, including transformed Z', () => {
  const m = sample();
  for (const pivot of [[NaN, 0, 0], [0, Infinity, 0], [0, 0, 0.1], [8388608, 0, 0], [-8388608 - 1 / 256, 0, 0], [0, 0, -8388608]]) {
    assert.throws(() => encodeKVX(m, { pivot: pivot as [number, number, number] }), /pivot|fixed|int32/i);
  }
  const pivot: [number, number, number] = [-8388608, 8388607 + 255 / 256, -1 / 256];
  assert.deepEqual(decodeKVX(encodeKVX(m, { pivot })).pivot, pivot);
});

test('KVX rejects malformed block sizes, dimensions, dictionary offsets and all truncations before voxel pushes', () => {
  const good = single();
  for (const [offset, value] of [[0, -1], [0, 0], [0, 0x7fffffff], [0, good.readInt32LE(0) - 1], [4, 0], [4, 257], [8, -1], [12, 256], [28, 11], [28, -1], [32, 11], [32, 0x7fffffff]]) {
    const b = Buffer.from(good); b.writeInt32LE(value!, offset!);
    noVoxelPush(() => decodeKVX(b), /KVX|dimension|offset|block|truncat/i);
  }
  for (const [offset, value] of [[36, 1], [38, 7], [38, 65535]]) {
    const b = Buffer.from(good); b.writeUInt16LE(value!, offset!);
    noVoxelPush(() => decodeKVX(b), /KVX|offset|slab/i);
  }
  for (let n = 0; n < good.length; n++) noVoxelPush(() => decodeKVX(good.subarray(0, n)), /KVX/i);
  for (const suffix of [Buffer.from([0]), Buffer.alloc(28)]) noVoxelPush(() => decodeKVX(Buffer.concat([good, suffix])), /KVX|trailing|mip/i);
});

test('KVX rejects descending/overlapping dictionaries, zero slabs, slab bounds/overlap, illegal visibility and palette', () => {
  const cases: Buffer[] = [];
  const two = file(level(2, 2, 3, [[0, 1, 63, 0], [], [2, 1, 63, 1], []]));
  for (const [offset, value] of [[32, 23], [36, 23]]) { const b = Buffer.from(two); b.writeInt32LE(value!, offset!); cases.push(b); }
  { const b = Buffer.from(two); b.writeUInt16LE(3, 44); cases.push(b); }
  for (const slab of [[0, 0, 63], [3, 1, 63, 0], [2, 2, 63, 0, 1], [0, 1, 64, 0], [1, 1, 63, 0, 0, 1, 63, 1], [0, 2, 63, 0, 1, 1, 1, 63, 1], [0, 1], [0, 2, 63, 0]]) cases.push(file(level(1, 1, 3, [slab])));
  { const b = single(); b[b.length - 1] = 64; cases.push(b); }
  for (const b of cases) noVoxelPush(() => decodeKVX(b), /KVX|offset|slab|visibility|palette/i);
  const badMip = level(1, 1, 2, [[0, 1, 128, 0]], [128, 128, 192]);
  noVoxelPush(() => decodeKVX(file(level(2, 2, 3, [[0, 1, 63, 0], [], [], []]), badMip)), /visibility/i);
});

test('KVX rejects >64 MiB before parsing and >2,000,000 stored voxels before materialization', () => {
  noVoxelPush(() => decodeKVX(Buffer.alloc(64 * 1024 * 1024 + 1)), /64|size|limit/i);
  const run = [0, 255, 63, ...Array<number>(255).fill(0)];
  const big = file(level(32, 250, 255, Array.from({ length: 32 * 250 }, () => run)));
  noVoxelPush(() => decodeKVX(big), /voxel.*limit|2,000,000|2000000/i);
  const highest = level(28, 250, 255, Array.from({ length: 28 * 250 }, () => run), [0, 0, 0]);
  const smaller = level(14, 125, 128, Array.from({ length: 14 * 125 }, () => [0, 128, 63, ...Array<number>(128).fill(0)]), [0, 0, 0]);
  noVoxelPush(() => decodeKVX(file(highest, smaller)), /voxel.*limit|2,000,000|2000000/i);
});

test('KVX export checks source count before iteration/allocation and rejects u16 x-column overflow', () => {
  const voxels = new Proxy([] as VoxModelData['voxels'], { get(_target, key) { if (key === 'length') return 2_000_001; throw new Error('source iterated before budget check'); } });
  assert.throws(() => encodeKVX({ sizeX: 256, sizeY: 256, sizeZ: 255, voxels }), /voxel.*limit|2000000|2,000,000/i);
  const m: VoxModelData = { sizeX: 1, sizeY: 256, sizeZ: 255, voxels: [] };
  for (let y = 0; y < 256; y++) for (let z = 0; z < 255; z++) m.voxels.push({ x: 0, y, z, i: 1 });
  assert.throws(() => encodeKVX(m), /column|65535|u16|offset/i);
});

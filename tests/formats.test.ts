import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packRGBA, unpackRGBA } from '../src/color.js';
import { decodeQB, encodeQB } from '../src/formats/qb.js';
import { decodeXRAW, encodeXRAW } from '../src/formats/xraw.js';
import { decodeSlab6, encodeSlab6 } from '../src/formats/slab6.js';
import type { VoxModelData } from '../src/vox.js';

function palette(): Uint32Array {
  const p = new Uint32Array(256);
  p[1] = packRGBA(255, 0, 0); p[2] = packRGBA(0, 255, 0); p[3] = packRGBA(0, 0, 255); p[255] = packRGBA(10, 20, 30);
  return p;
}
const sorted = (m: VoxModelData) => m.voxels.map(v => `${v.x},${v.y},${v.z}`).sort();
const colorAt = (m: VoxModelData, x: number, y: number, z: number) => {
  const v = m.voxels.find(w => w.x === x && w.y === y && w.z === z);
  return v ? unpackRGBA(m.palette![v.i]!) : undefined;
};
function sample(): VoxModelData {
  return { sizeX: 2, sizeY: 3, sizeZ: 4, palette: palette(), voxels: [{ x: 1, y: 2, z: 0, i: 1 }, { x: 0, y: 0, z: 3, i: 2 }, { x: 1, y: 1, z: 2, i: 3 }, { x: 0, y: 1, z: 1, i: 255 }] };
}

test('QB uncompressed export matches the documented byte layout (Y-up, left-handed, RGBA)', () => {
  const m: VoxModelData = { sizeX: 2, sizeY: 3, sizeZ: 1, palette: palette(), voxels: [{ x: 1, y: 2, z: 0, i: 1 }] };
  const b = encodeQB(m);
  assert.deepEqual([...b.subarray(0, 24)], [1, 1, 0, 0, /*rgba*/ 0, 0, 0, 0, /*left-handed*/ 0, 0, 0, 0, /*raw*/ 0, 0, 0, 0, /*mask*/ 0, 0, 0, 0, /*matrices*/ 1, 0, 0, 0]);
  const nameLen = b[24]!;
  assert.equal(b.toString('latin1', 25, 25 + nameLen), 'Model');
  let p = 25 + nameLen;
  assert.deepEqual([b.readUInt32LE(p), b.readUInt32LE(p + 4), b.readUInt32LE(p + 8)], [2, 1, 3]); // x, y(up = voxel z), z(= voxel y)
  assert.deepEqual([b.readInt32LE(p + 12), b.readInt32LE(p + 16), b.readInt32LE(p + 20)], [0, 0, 0]);
  p += 24;
  assert.equal(b.length - p, 2 * 1 * 3 * 4);
  // qb (x=1, y=0, z=2): slice 2, row 0, column 1 -> voxel number 2*2 + 1 = 5
  for (let i = 0; i < 6; i++) assert.deepEqual([...b.subarray(p + i * 4, p + i * 4 + 4)], i === 5 ? [255, 0, 0, 255] : [0, 0, 0, 0], `voxel ${i}`);
});

test('QB round trip keeps voxels and colors for raw and RLE data, in RGBA and BGRA order', () => {
  for (const opts of [{}, { compress: true }, { colorFormat: 'bgra' as const }, { compress: true, colorFormat: 'bgra' as const }]) {
    const m = sample();
    const bytes = encodeQB(m, opts);
    const { model } = decodeQB(bytes);
    assert.deepEqual([model.sizeX, model.sizeY, model.sizeZ], [2, 3, 4]);
    assert.deepEqual(sorted(model), sorted(m));
    assert.deepEqual(colorAt(model, 1, 2, 0), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepEqual(colorAt(model, 0, 1, 1), { r: 10, g: 20, b: 30, a: 255 });
    assert.deepEqual(colorAt(model, 1, 1, 2), { r: 0, g: 0, b: 255, a: 255 });
  }
});

test('QB decoder reads a hand-built RLE file with a position offset and right-handed orientation', () => {
  const u32 = (...n: number[]) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
  const red = Buffer.from([255, 0, 0, 255]), blue = Buffer.from([0, 0, 255, 255]);
  const name = Buffer.from('A');
  const matrix = Buffer.concat([
    Buffer.from([name.length]), name, u32(3, 1, 2), u32(5, 0, 0),
    u32(2, 2), red, blue, u32(6),            // slice 0: two red voxels via CODEFLAG, then one blue
    u32(0, 0, 0, 6),                         // slice 1: three empty voxels
  ]);
  const file = Buffer.concat([u32(0x101, 0, 1, 1, 0, 1), matrix]);
  const { model } = decodeQB(file);
  assert.deepEqual([model.sizeX, model.sizeY, model.sizeZ], [3, 2, 1]);
  assert.deepEqual(sorted(model), ['0,1,0', '1,1,0', '2,1,0'].sort());
  assert.deepEqual(colorAt(model, 2, 1, 0), { r: 0, g: 0, b: 255, a: 255 });
});

test('QB decoder rejects truncated, oversized and malformed input', () => {
  const good = encodeQB(sample());
  assert.throws(() => decodeQB(good.subarray(0, good.length - 3)), /truncated|QB/i);
  assert.throws(() => decodeQB(Buffer.from('nope')), /QB/);
  const huge = Buffer.from(good); const nameLen = huge[24]!;
  huge.writeUInt32LE(5000, 25 + nameLen);
  assert.throws(() => decodeQB(huge), /256|limit|size/i);
  const big: VoxModelData = { sizeX: 300, sizeY: 1, sizeZ: 1, voxels: [] };
  assert.throws(() => encodeQB(big), /256/);
});

test('XRAW export follows the documented header, x-fastest voxel order, index 0 as empty and RGBA palette', () => {
  const m: VoxModelData = { sizeX: 2, sizeY: 2, sizeZ: 1, palette: palette(), voxels: [{ x: 1, y: 1, z: 0, i: 3 }, { x: 0, y: 0, z: 0, i: 1 }] };
  const b = encodeXRAW(m);
  assert.equal(b.toString('latin1', 0, 4), 'XRAW');
  assert.deepEqual([...b.subarray(4, 8)], [0, 4, 8, 8]); // unsigned int, RGBA, 8 bit channels, 8 bit index
  assert.deepEqual([b.readUInt32LE(8), b.readUInt32LE(12), b.readUInt32LE(16), b.readUInt32LE(20)], [2, 2, 1, 256]);
  assert.deepEqual([...b.subarray(24, 28)], [1, 0, 0, 3]);
  assert.equal(b.length, 24 + 4 + 256 * 4);
  const pal = 28;
  assert.deepEqual([...b.subarray(pal, pal + 4)], [0, 0, 0, 0]);
  assert.deepEqual([...b.subarray(pal + 4, pal + 8)], [255, 0, 0, 255]);
});

test('XRAW round trip, direct-color files and validation', () => {
  const m = sample();
  const { model } = decodeXRAW(encodeXRAW(m));
  assert.deepEqual(sorted(model), sorted(m));
  assert.deepEqual(colorAt(model, 1, 1, 2), colorAt(m, 1, 1, 2));
  // bits_per_index = 0: every voxel stores its own RGBA, alpha 0 means empty
  const head = Buffer.alloc(24); head.write('XRAW', 0, 'latin1'); head.set([0, 4, 8, 0], 4);
  head.writeUInt32LE(2, 8); head.writeUInt32LE(1, 12); head.writeUInt32LE(1, 16);
  const direct = decodeXRAW(Buffer.concat([head, Buffer.from([9, 8, 7, 255, 0, 0, 0, 0])]));
  assert.deepEqual(sorted(direct.model), ['0,0,0']);
  assert.deepEqual(colorAt(direct.model, 0, 0, 0), { r: 9, g: 8, b: 7, a: 255 });
  assert.throws(() => decodeXRAW(Buffer.from('XRAW')), /XRAW/);
  const bad = encodeXRAW(m); bad[6] = 16;
  assert.throws(() => decodeXRAW(bad), /bits|channel|unsupported/i);
  assert.throws(() => decodeXRAW(encodeXRAW(m).subarray(0, 40)), /truncated|XRAW/i);
});

test('Slab6 VOX export follows the documented layout: z flipped, 255 empty, 6-bit palette', () => {
  const m: VoxModelData = { sizeX: 2, sizeY: 1, sizeZ: 3, palette: palette(), voxels: [{ x: 1, y: 0, z: 0, i: 1 }, { x: 0, y: 0, z: 2, i: 255 }] };
  const b = encodeSlab6(m);
  assert.deepEqual([b.readInt32LE(0), b.readInt32LE(4), b.readInt32LE(8)], [2, 1, 3]);
  assert.equal(b.length, 12 + 6 + 768);
  // offset = (x * ysiz + y) * zsiz + slabZ with slabZ = zsiz - 1 - voxelZ; stored color = voxel index - 1
  assert.deepEqual([...b.subarray(12, 18)], [254, 255, 255, 255, 255, 0]);
  const pal = 18;
  assert.deepEqual([...b.subarray(pal, pal + 3)], [63, 0, 0]);
  assert.deepEqual([...b.subarray(pal + 254 * 3, pal + 254 * 3 + 3)], [2, 5, 7]);
});

test('Slab6 VOX round trip keeps voxels; colors survive at 6-bit precision; limits are enforced', () => {
  const m = sample();
  const { model } = decodeSlab6(encodeSlab6(m));
  assert.deepEqual([model.sizeX, model.sizeY, model.sizeZ], [2, 3, 4]);
  assert.deepEqual(sorted(model), sorted(m));
  const c = colorAt(model, 1, 2, 0)!;
  assert.ok(c.r >= 252 && c.g === 0 && c.b === 0);
  assert.throws(() => encodeSlab6({ sizeX: 1, sizeY: 1, sizeZ: 256, voxels: [] }), /255/);
  assert.throws(() => decodeSlab6(Buffer.alloc(20)), /Slab6|size/i);
  assert.throws(() => decodeSlab6(encodeSlab6(m).subarray(0, 100)), /Slab6|size|truncated/i);
});

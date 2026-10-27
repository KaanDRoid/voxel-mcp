import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRaw, encodeRaw } from '../src/formats/raw.js';
import type { VoxModelData } from '../src/vox.js';

const palette = () => { const p = new Uint32Array(256); p[1] = 0x7f1450ff; p[2] = 0xffff5014; return p; };
const model = (): VoxModelData => ({ sizeX: 2, sizeY: 3, sizeZ: 4, palette: palette(), voxels: [{ x: 1, y: 2, z: 3, i: 1 }, { x: 0, y: 1, z: 2, i: 2 }] });
const colored = (m: VoxModelData) => m.voxels.map(v => [v.x, v.y, v.z, m.palette![v.i]]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('headerless RGBA8 has independent x-fastest bytes and preserves partial alpha exactly', () => {
  const input = model();
  const encoded = encodeRaw(input, { encoding: 'rgba8' });
  assert.equal(encoded.data.length, 2 * 3 * 4 * 4);
  const offset = (1 + 2 * (2 + 3 * 3)) * 4;
  assert.deepEqual([...encoded.data.subarray(offset, offset + 4)], [255, 80, 20, 127]);
  assert.deepEqual([...encoded.data.subarray(0, 4)], [0, 0, 0, 0]);
  const decoded = decodeRaw(encoded.data, encoded.metadata);
  assert.deepEqual(colored(decoded.model), colored(input));
  assert.deepEqual(decoded.warnings, []);
  assert.throws(() => decodeRaw(encoded.data, { ...encoded.metadata, sizeX: 3 }), /length|size/i);
});

test('an explicit RGB empty sentinel may never erase an occupied color, even in a full grid', () => {
  const p = new Uint32Array(256); p[1] = 0xff000000;
  const m = { sizeX: 1, sizeY: 1, sizeZ: 1, palette: p, voxels: [{ x: 0, y: 0, z: 0, i: 1 }] };
  assert.throws(() => encodeRaw(m, { encoding: 'rgb8', emptyColor: 0 }), /collides/);
});

for (const encoding of ['rgba8', 'indexed8'] as const) for (const order of ['x-fastest', 'z-fastest'] as const) test(`${encoding} ${order} round-trips asymmetric occupied cells and RGBA colors`, () => {
  const m = model(), output = encodeRaw(m, { encoding, order });
  assert.deepEqual(colored(decodeRaw(output.data, output.metadata).model), colored(m));
  if (order === 'z-fastest' && encoding === 'indexed8') assert.equal(output.data[3 + 4 * (2 + 3 * 1)], 1);
});

test('RGB8 records an unused empty sentinel instead of confusing occupied black with empty', () => {
  const m = model(); m.palette![1] = 0xff000000;
  const output = encodeRaw(m, { encoding: 'rgb8' });
  assert.equal(output.metadata.emptyColor, 1);
  assert.deepEqual(colored(decodeRaw(output.data, output.metadata).model), colored(m));
  assert.equal(decodeRaw(Buffer.from([0,0,0]), {sizeX:1,sizeY:1,sizeZ:1,encoding:'rgb8'}).model.voxels.length, 1);
});

test('RGB alpha loss is explicit while indexed8 and RGBA8 preserve nonzero partial alpha', () => {
  const output = encodeRaw(model(), { encoding: 'rgb8' });
  assert.match(output.warnings.join(' '), /alpha/i);
  const transparent = model(); transparent.palette![1] = 0x001450ff;
  assert.throws(() => encodeRaw(transparent, { encoding: 'rgba8' }), /zero-alpha/);
});

test('RAW refuses invalid, ambiguous or truncated layouts rather than guessing', () => {
  const d = { sizeX:1,sizeY:1,sizeZ:1,encoding:'rgba8' as const };
  for (const sizeX of [0,257,1.5,Infinity]) assert.throws(() => decodeRaw(Buffer.alloc(4), { ...d,sizeX }));
  assert.throws(() => decodeRaw(Buffer.alloc(3), d), /length/);
  assert.throws(() => decodeRaw(Buffer.alloc(5), d), /length/);
  assert.throws(() => decodeRaw(Buffer.alloc(4), {...d,encoding:'float32' as never}), /encoding/);
  assert.throws(() => decodeRaw(Buffer.alloc(4), {...d,order:'unknown' as never}), /order/);
  assert.throws(() => decodeRaw(Buffer.alloc(4), {...d,emptyColor:0}), /RGB8/);
  assert.throws(() => decodeRaw(Buffer.alloc(1), {...d,encoding:'indexed8',palette:[0]}), /256/);
});

test('RAW color and occupancy budgets fail before voxel materialization', () => {
  const data = Buffer.alloc(256*3); for(let i=0;i<256;i++) data[i*3]=i;
  assert.throws(() => decodeRaw(data,{sizeX:256,sizeY:1,sizeZ:1,encoding:'rgb8'}),/255 distinct/);
  assert.throws(() => decodeRaw(Buffer.alloc(256*256*31,1),{sizeX:256,sizeY:256,sizeZ:31,encoding:'indexed8'}),/budget/i);
  const entries = Array(2_000_001); Object.defineProperty(entries, 0, {get(){throw new Error('element accessed too early');}});
  assert.throws(() => encodeRaw({...model(),voxels:entries},{encoding:'rgba8'}),/budget/i);
});

test('RAW export rejects duplicate and malformed occupied coordinates', () => {
  const m=model();m.voxels.push({...m.voxels[0]!});assert.throws(()=>encodeRaw(m,{encoding:'rgba8'}),/Duplicate/);
  m.voxels=[{x:0.5,y:0,z:0,i:1}];assert.throws(()=>encodeRaw(m,{encoding:'rgba8'}),/Invalid/);
});

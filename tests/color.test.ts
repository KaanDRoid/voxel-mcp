import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorMatcher, deltaE, medianCut, packRGBA, parseCssColor, rgbToLab, unpackRGBA } from '../src/color.js';
import { applyAxis, axisHandedness, invertAxis, makeTransform, parseAxis } from '../src/formats/axes.js';
import { buildQuads } from '../src/formats/mesh.js';
import type { VoxModelData } from '../src/vox.js';

test('pack/unpack uses little-endian RGBA byte order', () => {
  assert.equal(packRGBA(1, 2, 3, 4), 0x04030201);
  assert.deepEqual(unpackRGBA(0x04030201), { r: 1, g: 2, b: 3, a: 4 });
});

test('CSS colors parse and unsupported ones return undefined', () => {
  assert.deepEqual(parseCssColor('#f00'), [255, 0, 0]);
  assert.deepEqual(parseCssColor('#336699'), [0x33, 0x66, 0x99]);
  assert.deepEqual(parseCssColor('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.deepEqual(parseCssColor('Red'), [255, 0, 0]);
  assert.equal(parseCssColor('url(#grad)'), undefined);
});

test('Lab conversion matches reference values and nearest search prefers perceptual neighbours', () => {
  const white = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(white[0] - 100) < 0.01 && Math.abs(white[1]) < 0.01);
  const red = rgbToLab(255, 0, 0);
  assert.ok(Math.abs(red[0] - 53.24) < 0.1 && Math.abs(red[1] - 80.09) < 0.1);
  assert.equal(deltaE(red, red), 0);
  const m = new ColorMatcher([[0, 0, 0], [255, 0, 0], [0, 0, 255]], 'lab');
  assert.equal(m.nearest(200, 20, 20).index, 1);
  assert.equal(new ColorMatcher([[0, 0, 0]], 'rgb').nearest(5, 5, 5).index, 0);
});

test('median cut keeps few colors exactly and reduces many colors to the requested count', () => {
  const few = medianCut([{ rgb: [1, 2, 3], weight: 5 }, { rgb: [9, 9, 9], weight: 1 }], 4);
  assert.deepEqual(few, [[1, 2, 3], [9, 9, 9]]);
  const many = Array.from({ length: 300 }, (_, i) => ({ rgb: [i % 256, (i * 7) % 256, (i * 13) % 256] as [number, number, number], weight: 1 }));
  const out = medianCut(many, 16);
  assert.equal(out.length, 16);
  assert.throws(() => medianCut(many, 0), /positive/);
});

test('axis specs parse, invert and report handedness', () => {
  const yUp = parseAxis('XZ-Y');
  assert.deepEqual(applyAxis(yUp, [1, 2, 3]), [1, 3, -2]);
  assert.deepEqual(invertAxis(yUp, [1, 3, -2]), [1, 2, 3]);
  assert.equal(axisHandedness(yUp), 1);
  assert.equal(axisHandedness(parseAxis('XYZ')), 1);
  assert.equal(axisHandedness(parseAxis('XZY')), -1);
  for (const bad of ['XXZ', 'XY', 'ABC', 'XYZW', '']) assert.throws(() => parseAxis(bad), /axis/i);
  const t = makeTransform({ scale: 0.5, cw: true }, 'XZ-Y');
  assert.deepEqual(t.point([2, 4, 6]), [1, 3, -2]);
  assert.equal(t.flip, true);
  assert.throws(() => makeTransform({ scale: 0 }, 'XYZ'), /scale/);
});

test('greedy merging reduces face count and preserves covered area', () => {
  const voxels = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) voxels.push({ x, y, z: 0, i: 1 });
  const m: VoxModelData = { sizeX: 4, sizeY: 4, sizeZ: 1, voxels };
  const plain = buildQuads(m, false), merged = buildQuads(m, true);
  assert.equal(plain.length, 32 + 16);
  assert.equal(merged.length, 6);
  const area = (qs: typeof plain) => qs.reduce((s, q) => {
    const [a, b, , d] = q.corners as [number, number, number][];
    const u = b!.map((n, i) => n - a![i]!), v = d!.map((n, i) => n - a![i]!);
    return s + Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
  }, 0);
  assert.equal(area(plain), area(merged));
  assert.equal(area(plain), 2 * 16 + 4 * 4);
  const two: VoxModelData = { sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [{ x: 0, y: 0, z: 0, i: 1 }, { x: 1, y: 0, z: 0, i: 2 }] };
  assert.equal(buildQuads(two, true).length, 10);
});

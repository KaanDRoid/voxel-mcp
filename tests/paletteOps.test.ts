import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPalette, type VoxModelData } from '../src/vox.js';
import { packRGBA, unpackRGBA } from '../src/color.js';
import { findNearestColors, mergeModelPalettes, quantizeModel, remapModelToPalette, sortModelPalette } from '../src/paletteOps.js';

function model(colors: [number, number, number][], extra: Partial<VoxModelData> = {}): VoxModelData {
  const palette = new Uint32Array(256);
  colors.forEach((c, i) => { palette[i + 1] = packRGBA(c[0], c[1], c[2]); });
  return { sizeX: colors.length, sizeY: 1, sizeZ: 1, palette, voxels: colors.map((_, i) => ({ x: i, y: 0, z: 0, i: i + 1 })), ...extra };
}
const rgbOf = (m: VoxModelData, i: number) => { const c = unpackRGBA(m.palette![i]!); return [c.r, c.g, c.b]; };

test('remap moves voxels to the nearest target entry and reports the color error', () => {
  const m = model([[250, 10, 10], [10, 10, 250], [100, 100, 100]]);
  const target = new Uint32Array(256);
  target[5] = packRGBA(255, 0, 0); target[9] = packRGBA(0, 0, 255); target[20] = packRGBA(90, 90, 90);
  const report = remapModelToPalette(m, target);
  assert.deepEqual(m.voxels.map(v => v.i), [5, 9, 20]);
  assert.equal(m.palette![5], target[5]);
  assert.ok(report.meanDeltaE > 0 && report.meanDeltaE < 10);
  assert.ok(report.maxDeltaE >= report.meanDeltaE);
  assert.equal(report.voxels, 3);
  const exact = model([[1, 2, 3]]);
  const t2 = new Uint32Array(256); t2[7] = packRGBA(1, 2, 3);
  assert.equal(remapModelToPalette(exact, t2).meanDeltaE, 0);
});

test('remap supports rgb metric and ignores fully transparent target entries', () => {
  const m = model([[10, 10, 10]]);
  const target = new Uint32Array(256);
  target[3] = packRGBA(10, 10, 10, 0); target[4] = packRGBA(200, 200, 200);
  remapModelToPalette(m, target, { metric: 'rgb' });
  assert.equal(m.voxels[0]!.i, 4);
  assert.throws(() => remapModelToPalette(model([[1, 1, 1]]), new Uint32Array(256)), /no usable/i);
});

test('quantize reduces the number of used colors and keeps voxels valid', () => {
  const colors: [number, number, number][] = [];
  for (let i = 0; i < 200; i++) colors.push([i, (i * 3) % 256, (i * 5) % 256]);
  const m = model(colors);
  const report = quantizeModel(m, 8);
  assert.equal(report.colorsBefore, 200);
  assert.ok(report.colorsAfter <= 8 && report.colorsAfter >= 1);
  assert.equal(new Set(m.voxels.map(v => v.i)).size, report.colorsAfter);
  assert.ok(m.voxels.every(v => v.i >= 1 && v.i <= 255));
  assert.ok(report.meanDeltaE > 0);
  assert.throws(() => quantizeModel(m, 0), /maxColors/);
  const few = model([[1, 1, 1], [200, 0, 0]]);
  const r = quantizeModel(few, 16);
  assert.equal(r.colorsAfter, 2); assert.equal(r.meanDeltaE, 0);
});

test('sort by luminance and hue reorders palette entries and rewrites voxel indices without changing colors', () => {
  const m = model([[250, 250, 250], [10, 10, 10], [120, 120, 120]]);
  const before = m.voxels.map(v => rgbOf(m, v.i));
  sortModelPalette(m, 'lum');
  assert.deepEqual(m.voxels.map(v => rgbOf(m, v.i)), before);
  const byLum = [1, 2, 3].map(i => rgbOf(m, i)[0]);
  assert.deepEqual(byLum, [10, 120, 250]);
  const h = model([[0, 0, 255], [255, 0, 0], [0, 255, 0]]);
  const beforeH = h.voxels.map(v => rgbOf(h, v.i));
  sortModelPalette(h, 'hue');
  assert.deepEqual(h.voxels.map(v => rgbOf(h, v.i)), beforeH);
  assert.deepEqual([1, 2, 3].map(i => rgbOf(h, i)), [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
  assert.equal(h.palette![0], 0);
});

test('nearest color lookup ranks palette entries', () => {
  const p = defaultPalette();
  const hits = findNearestColors(p, [255, 255, 255], { count: 2 });
  assert.equal(hits[0]!.index, 1);
  assert.equal(hits[0]!.hex, '#ffffff');
  assert.equal(hits[0]!.deltaE, 0);
  assert.equal(hits.length, 2);
  assert.ok(hits[1]!.deltaE >= hits[0]!.deltaE);
});

test('models with different palettes can be merged onto one shared palette', () => {
  const a = model([[255, 0, 0], [0, 255, 0]]);
  const b = model([[0, 255, 0], [0, 0, 255]]);
  const before = [...a.voxels.map(v => rgbOf(a, v.i)), ...b.voxels.map(v => rgbOf(b, v.i))];
  const report = mergeModelPalettes([a, b]);
  assert.deepEqual(a.palette, b.palette);
  assert.deepEqual([...a.voxels.map(v => rgbOf(a, v.i)), ...b.voxels.map(v => rgbOf(b, v.i))], before);
  assert.equal(report.colors, 3);
  assert.equal(report.meanDeltaE, 0);
  assert.equal(a.voxels[1]!.i, b.voxels[0]!.i);
  assert.throws(() => mergeModelPalettes([a]), /two/);
});

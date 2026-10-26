import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { exportOBJ, exportPLY } from '../src/export.js';
import { exportSTL, exportGLTF } from '../src/export_extra.js';
import type { VoxModelData } from '../src/vox.js';

function withDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'voxel-parity-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const palette = new Uint32Array(256); palette[1] = 0xff0000ff; palette[2] = 0xff00ff00;
const single: VoxModelData = { sizeX: 2, sizeY: 3, sizeZ: 4, palette, voxels: [{ x: 1, y: 2, z: 3, i: 1 }] };
function plate(): VoxModelData {
  const voxels = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) voxels.push({ x, y, z: 0, i: 1 });
  return { sizeX: 4, sizeY: 4, sizeZ: 1, palette, voxels };
}
const bounds = (pts: number[][]) => [0, 1, 2].map(a => [Math.min(...pts.map(p => p[a]!)), Math.max(...pts.map(p => p[a]!))]);
const objPoints = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('v ')).map(l => l.split(/\s+/).slice(1, 4).map(Number));
const stlPoints = (file: string) => [...fs.readFileSync(file, 'utf8').matchAll(/vertex (\S+) (\S+) (\S+)/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
function gltfPoints(file: string) {
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = g.accessors[g.meshes[0].primitives[0].attributes.POSITION];
  return [a.min, a.max] as number[][];
}

test('MagicaVoxel OBJ profile writes obj, mtl and a 256x1 palette texture with scale, Y-up axes and merged faces', () => withDir(dir => {
  const file = path.join(dir, 'plate.obj');
  const stats = exportOBJ(plate(), file, { profile: 'magica' });
  assert.equal(stats.faces, 6);
  assert.deepEqual(stats.files.map(f => path.basename(f)).sort(), ['plate.mtl', 'plate.obj', 'plate.png']);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^mtllib plate\.mtl$/m);
  assert.match(text, /^usemtl palette$/m);
  assert.match(fs.readFileSync(path.join(dir, 'plate.mtl'), 'utf8'), /map_Kd plate\.png/);
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, 'plate.png')));
  assert.equal(png.width, 256); assert.equal(png.height, 1);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // index 1 is pixel 0
  // scale 0.1, XZ-Y: x 0..0.4, y (voxel z) 0..0.1, z (-voxel y) -0.4..0
  assert.deepEqual(bounds(objPoints(file)), [[0, 0.4], [0, 0.1], [-0.4, 0]]);
  const uv = text.split('\n').filter(l => l.startsWith('vt '));
  assert.equal(uv.length, 1);
  assert.ok(Math.abs(Number(uv[0]!.split(' ')[1]) - 0.5 / 256) < 1e-6);
  assert.ok(text.split('\n').filter(l => l.startsWith('f ')).every(l => /^f (\d+\/\d+ ?){4}$/.test(l)));
}));

test('merge option changes face count and cw reverses winding', () => withDir(dir => {
  const a = path.join(dir, 'a.obj'), b = path.join(dir, 'b.obj'), c = path.join(dir, 'c.obj');
  assert.equal(exportOBJ(plate(), a, { merge: false }).faces, 48);
  assert.equal(exportOBJ(plate(), b, { merge: true }).faces, 6);
  assert.equal(exportOBJ(plate(), c, { merge: true, cw: true }).faces, 6);
  const first = (f: string) => fs.readFileSync(f, 'utf8').split('\n').find(l => l.startsWith('f '))!.split(' ').slice(1).map(Number);
  assert.deepEqual(first(c), [...first(b)].reverse());
  assert.equal(fs.existsSync(path.join(dir, 'a.mtl')), false);
}));

test('OBJ axis option converts between Z-up and Y-up conventions', () => withDir(dir => {
  const zUp = path.join(dir, 'z.obj'), yUp = path.join(dir, 'y.obj');
  exportOBJ(single, zUp, { axis: 'XYZ', scale: 1 });
  exportOBJ(single, yUp, { axis: 'XZ-Y', scale: 1 });
  assert.deepEqual(bounds(objPoints(zUp)), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(bounds(objPoints(yUp)), [[1, 2], [3, 4], [-3, -2]]);
  assert.throws(() => exportOBJ(single, zUp, { axis: 'XXZ' }), /axis/i);
  assert.throws(() => exportOBJ(single, zUp, { scale: -1 }), /scale/);
}));

test('the same model has the same physical size in OBJ, glTF, STL and PLY for equal axis and scale', () => withDir(dir => {
  const opts = { axis: 'XYZ', scale: 0.5 };
  const obj = path.join(dir, 'm.obj'), stl = path.join(dir, 'm.stl'), gltf = path.join(dir, 'm.gltf'), ply = path.join(dir, 'm.ply');
  exportOBJ(single, obj, opts); exportSTL(single, stl, opts); exportGLTF(single, gltf, opts); exportPLY(single, ply, opts);
  const expected = [[0.5, 1], [1, 1.5], [1.5, 2]];
  assert.deepEqual(bounds(objPoints(obj)), expected);
  assert.deepEqual(bounds(stlPoints(stl)), expected);
  const [min, max] = gltfPoints(gltf);
  assert.deepEqual([0, 1, 2].map(i => [min![i], max![i]]), expected);
  const plyPts = fs.readFileSync(ply, 'utf8').trim().split('\n').slice(-1)[0]!.split(' ').slice(0, 3).map(Number);
  assert.deepEqual(plyPts, [0.5, 1, 1.5]);
}));

test('default conventions: glTF and OBJ are Y-up, STL is Z-up, all with unit scale', () => withDir(dir => {
  const obj = path.join(dir, 'm.obj'), stl = path.join(dir, 'm.stl'), gltf = path.join(dir, 'm.gltf');
  const full: VoxModelData = { sizeX: 2, sizeY: 3, sizeZ: 4, palette, voxels: [] };
  for (let x = 0; x < 2; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) full.voxels.push({ x, y, z, i: 1 });
  exportOBJ(full, obj); exportSTL(full, stl); exportGLTF(full, gltf);
  const extent = (b: number[][]) => b.map(([lo, hi]) => hi! - lo!);
  assert.deepEqual(extent(bounds(objPoints(obj))), [2, 4, 3]);
  assert.deepEqual(extent(bounds(stlPoints(stl))), [2, 3, 4]);
  const [min, max] = gltfPoints(gltf);
  assert.deepEqual([0, 1, 2].map(i => max![i]! - min![i]!), [2, 4, 3]);
}));

test('STL facets keep outward normals under every supported axis mapping', () => withDir(dir => {
  for (const axis of ['XYZ', 'XZ-Y', 'XZY', '-XYZ']) {
    const file = path.join(dir, `m${axis}.stl`);
    exportSTL(plate(), file, { axis });
    const facets = [...fs.readFileSync(file, 'utf8').matchAll(/facet normal (\S+) (\S+) (\S+)\n\s+outer loop\n\s+vertex (\S+) (\S+) (\S+)\n\s+vertex (\S+) (\S+) (\S+)\n\s+vertex (\S+) (\S+) (\S+)/g)];
    assert.equal(facets.length, 96);
    for (const f of facets) {
      const n = f.slice(1, 4).map(Number), a = f.slice(4, 7).map(Number), b = f.slice(7, 10).map(Number), c = f.slice(10, 13).map(Number);
      const u = b.map((v, i) => v - a[i]!), v = c.map((w, i) => w - a[i]!);
      const g = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      assert.ok(g.reduce((s, x, i) => s + x * n[i]!, 0) > 0, `${axis} facet winding`);
    }
  }
}));

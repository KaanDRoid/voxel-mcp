import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { importOBJData } from '../src/importers.js';
import { unpackRGBA } from '../src/color.js';

function cubeObj(size: number, extra = ''): string {
  const s = size;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  // outward-facing quads (counter-clockwise seen from outside)
  const f = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
  return extra + v.map(p => `v ${p.join(' ')}`).join('\n') + '\n' + f.map(q => `f ${q.join(' ')}`).join('\n') + '\n';
}
const key = (v: { x: number; y: number; z: number }) => `${v.x},${v.y},${v.z}`;
const colorOf = (r: ReturnType<typeof importOBJData>, x: number, y: number, z: number) => {
  const v = r.voxels.find(w => w.x === x && w.y === y && w.z === z);
  return v ? unpackRGBA(r.palette![v.i]!) : undefined;
};

test('a closed cube becomes a completely filled volume; surface mode leaves it hollow', () => {
  const solid = importOBJData(cubeObj(4), {});
  assert.deepEqual([solid.sizeX, solid.sizeY, solid.sizeZ], [4, 4, 4]);
  assert.equal(solid.voxels.length, 64);
  assert.deepEqual(solid.warnings, []);
  const shell = importOBJData(cubeObj(4), { fill: 'surface' });
  assert.equal(shell.voxels.length, 56);
  assert.ok(!shell.voxels.some(v => v.x >= 1 && v.x <= 2 && v.y >= 1 && v.y <= 2 && v.z >= 1 && v.z <= 2));
  assert.equal(new Set(solid.voxels.map(key)).size, 64);
});

test('a closed sphere is filled with roughly the analytic volume and nothing outside the radius', () => {
  const lines: string[] = [], faces: string[] = [];
  const seg = 24, ring = 16, r = 8, c = 10;
  lines.push(`v ${c} ${c + r} ${c}`);
  for (let i = 1; i < ring; i++) for (let j = 0; j < seg; j++) {
    const phi = Math.PI * i / ring, th = 2 * Math.PI * j / seg;
    lines.push(`v ${c + r * Math.sin(phi) * Math.cos(th)} ${c + r * Math.cos(phi)} ${c + r * Math.sin(phi) * Math.sin(th)}`);
  }
  lines.push(`v ${c} ${c - r} ${c}`);
  const idx = (i: number, j: number) => 2 + (i - 1) * seg + (j % seg);
  const bottom = 2 + (ring - 1) * seg;
  for (let j = 0; j < seg; j++) faces.push(`f 1 ${idx(1, j + 1)} ${idx(1, j)}`);
  for (let i = 1; i < ring - 1; i++) for (let j = 0; j < seg; j++) faces.push(`f ${idx(i, j)} ${idx(i, j + 1)} ${idx(i + 1, j + 1)} ${idx(i + 1, j)}`);
  for (let j = 0; j < seg; j++) faces.push(`f ${bottom} ${idx(ring - 1, j)} ${idx(ring - 1, j + 1)}`);
  const result = importOBJData(lines.join('\n') + '\n' + faces.join('\n'), {});
  assert.deepEqual(result.warnings, []);
  const expected = 4 / 3 * Math.PI * r ** 3;
  assert.ok(Math.abs(result.voxels.length - expected) / expected < 0.12, `volume ${result.voxels.length} vs ${expected}`);
  const cx = result.sizeX / 2, cy = result.sizeY / 2, cz = result.sizeZ / 2;
  assert.ok(result.voxels.every(v => Math.hypot(v.x + .5 - cx, v.y + .5 - cy, v.z + .5 - cz) <= r + 1.2));
  assert.ok(result.voxels.some(v => v.x === Math.floor(cx) && v.y === Math.floor(cy) && v.z === Math.floor(cz)));
});

test('open meshes are reported and only their surface is voxelized', () => {
  const obj = 'v 0 0 0\nv 6 0 0\nv 0 6 0\nf 1 2 3\n';
  const r = importOBJData(obj, {});
  assert.match(r.warnings.join(' '), /watertight/);
  assert.ok(r.voxels.length > 0);
  const flat = importOBJData('v 0 0 0\nv 3 0 0\nv 3 0 3\nv 0 0 3\nf 1 2 3 4\n', { sizeX: 3, sizeY: 3, sizeZ: 1 });
  assert.equal(flat.voxels.length, 9);
});

test('materials: usemtl and Kd colors map to the palette, interior voxels inherit nearby face colors', () => {
  const obj = 'mtllib m.mtl\n' + cubeObj(4).replace('f 3 4 8 7', 'usemtl top\nf 3 4 8 7').replace('f 1 4 3 2', 'usemtl side\nf 1 4 3 2');
  const aux = (name: string) => name === 'm.mtl' ? Buffer.from('newmtl top\nKd 1 0 0\nnewmtl side\nKd 0 0 1\n') : undefined;
  const r = importOBJData(obj, { readAux: aux });
  // face 3 4 8 7 is the y = 4 plane in OBJ space, which is the voxel z = 4 (top) layer
  assert.deepEqual(colorOf(r, 1, 1, 3), { r: 255, g: 0, b: 0, a: 255 });
  assert.equal(r.voxels.length, 64);
  assert.ok(r.voxels.every(v => r.palette![v.i]! !== 0));
});

test('per-vertex colors are interpolated and PNG textures are sampled through UVs', () => {
  const colored = importOBJData('v 0 0 0 1 0 0\nv 8 0 0 1 0 0\nv 8 8 0 0 0 1\nv 0 8 0 0 0 1\nf 1 2 3 4\n', {});
  assert.deepEqual(colorOf(colored, 0, 0, 0)!.r > 200, true);
  assert.deepEqual(colorOf(colored, 7, 0, 7)!.b > 200, true);
  const tex = new PNG({ width: 2, height: 1 });
  tex.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
  const obj = 'mtllib t.mtl\nusemtl t\nv 0 0 0\nv 8 0 0\nv 8 8 0\nv 0 8 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n';
  const aux = (name: string) => name === 't.mtl' ? Buffer.from('newmtl t\nKd 1 1 1\nmap_Kd tex.png\n') : name === 'tex.png' ? PNG.sync.write(tex) : undefined;
  const r = importOBJData(obj, { readAux: aux });
  assert.deepEqual(colorOf(r, 1, 0, 4), { r: 255, g: 0, b: 0, a: 255 });
  assert.deepEqual(colorOf(r, 6, 0, 4), { r: 0, g: 255, b: 0, a: 255 });
  const missing = importOBJData(obj, { readAux: n => n === 't.mtl' ? Buffer.from('newmtl t\nmap_Kd nope.png\n') : undefined });
  assert.match(missing.warnings.join(' '), /nope\.png/);
});

test('axis, scale, fit and explicit sizes control the voxel grid', () => {
  const tall = 'v 0 0 0\nv 2 0 0\nv 2 6 0\nv 0 6 0\nv 0 0 2\nv 2 0 2\nv 2 6 2\nv 0 6 2\n'
    + 'f 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n';
  const yUp = importOBJData(tall, {});
  assert.deepEqual([yUp.sizeX, yUp.sizeY, yUp.sizeZ], [2, 2, 6]);
  const zUp = importOBJData(tall, { axis: 'XYZ' });
  assert.deepEqual([zUp.sizeX, zUp.sizeY, zUp.sizeZ], [2, 6, 2]);
  const half = importOBJData(cubeObj(16), { scale: 2 });
  assert.deepEqual([half.sizeX, half.sizeY, half.sizeZ], [8, 8, 8]);
  const fit = importOBJData(cubeObj(16), { fit: { max: 6 } });
  assert.deepEqual([fit.sizeX, fit.sizeY, fit.sizeZ], [6, 6, 6]);
  const stretch = importOBJData(cubeObj(4), { sizeX: 8, sizeY: 4, sizeZ: 2 });
  assert.deepEqual([stretch.sizeX, stretch.sizeY, stretch.sizeZ], [8, 4, 2]);
  assert.equal(stretch.voxels.length, 64);
  assert.throws(() => importOBJData(cubeObj(1000), {}), /256/);
  assert.throws(() => importOBJData(cubeObj(4), { fit: { max: 300 } }), /256/);
  assert.throws(() => importOBJData(cubeObj(4), { axis: 'XX' }), /axis/i);
  assert.throws(() => importOBJData(cubeObj(4), { maxTriangles: 5 }), /triangle/i);
});

test('malformed OBJ input is rejected with explicit errors', () => {
  assert.throws(() => importOBJData('v 1 2\nf 1 1 1\n', {}), /vertex/);
  assert.throws(() => importOBJData('v 0 0 0\nf 1 2 3\n', {}), /range/);
  assert.throws(() => importOBJData('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 0 3\n', {}), /index/);
  assert.throws(() => importOBJData('# empty\n', {}), /geometry|faces/i);
  const grid = importOBJData('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', { sizeX: 4, sizeY: 4, sizeZ: 4 });
  assert.ok(grid.voxels.length > 0);
});

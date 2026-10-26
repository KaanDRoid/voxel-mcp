import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importOBJ, importSVG } from '../src/importers.js';
import type { VoxModelData } from '../src/vox.js';

async function fixture(ext: string, text: string, fn: (file: string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'voxel-import-'));
  try { const file = path.join(dir, `test.${ext}`); fs.writeFileSync(file, text); await fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const fresh = (w = 10, h = 10, d = 1): VoxModelData => ({ sizeX: w, sizeY: h, sizeZ: d, voxels: [] });
const cell = (m: VoxModelData, x: number, y: number) => m.voxels.find(v => v.x === x && v.y === y && v.z === 0);
const rgbOfIndex = (m: VoxModelData, i: number) => { const c = m.palette![i]!; return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]; };

test('SVG malformed geometry is rejected before mutating the model', async () => fixture('svg', "<svg><rect width='10' height='10'/><circle r='invalid'/></svg>", file => {
  const m = fresh(); assert.throws(() => importSVG(m, file, {}), /numeric/); assert.equal(m.voxels.length, 0);
}));

test('SVG unsupported features fail explicitly rather than importing incorrect silhouettes', async () => {
  const cases: [string, RegExp][] = [
    ["<text x='1' y='5'>hi</text>", /unsupported SVG element <text>/],
    ["<use href='#a'/>", /unsupported SVG element <use>/],
    ["<defs><linearGradient id='g'/></defs><rect width='5' height='5'/>", /unsupported SVG element <defs>/],
    ["<rect width='5' height='5' fill='url(#g)'/>", /unsupported SVG fill/],
    ["<rect width='5' height='5' stroke='red'/>", /unsupported SVG stroke/],
    ["<rect width='5' height='5' class='a'/>", /unsupported SVG class/],
    ["<rect width='5' height='5' clip-path='url(#c)'/>", /unsupported SVG clip-path/],
    ["<rect width='5' height='5' opacity='0.5'/>", /unsupported SVG opacity/],
    ["<path d='M0 0 A5 5 0 0 1 10 10Z'/>", /unsupported SVG path command A/],
    ["<path d='M0 0 X5'/>", /unsupported SVG path command X/],
    ["<rect width='5' height='5' fill='currentColor'/>", /unsupported SVG fill/],
    ["<g transform='frob(3)'><rect width='5' height='5'/></g>", /unsupported SVG transform/],
    ["<svg><rect width='5' height='5'/></svg>", /nested/],
    ["<style>rect{fill:red}</style>", /unsupported SVG element <style>/],
  ];
  for (const [body, expected] of cases) {
    await fixture('svg', `<svg viewBox='0 0 10 10'>${body}</svg>`, file => {
      const m = fresh(); assert.throws(() => importSVG(m, file, {}), expected, body); assert.equal(m.voxels.length, 0);
    });
  }
});

test('SVG rectangle attribute order/defaults and single quotes preserve viewport and clip outside geometry', async () => fixture('svg', "<svg viewBox='0 0 10 10'><rect height='5' width='5'/><rect width='3' height='3' x='30' y='30'/></svg>", file => {
  const m = fresh(10, 10, 2); importSVG(m, file, { thickness: 1.9 }); assert.equal(m.voxels.length, 25);
  assert.ok(m.voxels.every(v => v.x >= 0 && v.x < 5 && v.y >= 5 && v.y < 10 && v.z === 0));
  importSVG(m, file, { thickness: 1 }); assert.equal(m.voxels.length, 25);
}));

test('SVG circles remain clipped and geometrically correct in a nonsquare viewport', async () => fixture('svg', "<svg viewBox='0 0 20 10'><circle r='4' cy='0' cx='0'/></svg>", file => {
  const m = fresh(20, 20); importSVG(m, file, {}); assert.ok(m.voxels.length > 0);
  assert.ok(m.voxels.every(v => v.x >= 0 && v.x < 20 && v.y >= 0 && v.y < 20 && v.z === 0));
  assert.ok(m.voxels.some(v => v.y === 12)); assert.ok(!m.voxels.some(v => v.x >= 4));
}));

test('SVG paths: absolute and relative commands, H/V, Z and implicit lineto give the expected silhouette', async () => {
  await fixture('svg', "<svg viewBox='0 0 10 10'><path d='M1 1 H9 V9 H1 Z' fill='#00ff00'/></svg>", file => {
    const m = fresh(); const r = importSVG(m, file, {}); assert.equal(r.count, 64); assert.equal(m.voxels.length, 64);
    assert.ok(m.voxels.every(v => v.x >= 1 && v.x < 9 && v.y >= 1 && v.y < 9)); assert.deepEqual(rgbOfIndex(m, m.voxels[0]!.i), [0, 255, 0]);
  });
  await fixture('svg', "<svg viewBox='0 0 10 10'><path d='m 0,0 l 10,0 0,10 z' fill='red'/></svg>", file => {
    const m = fresh(); importSVG(m, file, {});
    // triangle (0,0) (10,0) (10,10) in SVG space: upper right half of the image
    assert.ok(cell(m, 9, 9)); assert.ok(!cell(m, 0, 8)); assert.ok(!cell(m, 0, 0));
    assert.ok(m.voxels.length >= 45 && m.voxels.length <= 55, String(m.voxels.length));
  });
});

test('SVG curves are flattened: four cubic segments form a disc and a quadratic bounds the expected area', async () => {
  const k = 0.5523;
  const d = `M10 0 C10 ${10 * k} ${10 * k} 10 0 10 C${-10 * k} 10 -10 ${10 * k} -10 0 C-10 ${-10 * k} ${-10 * k} -10 0 -10 C${10 * k} -10 10 ${-10 * k} 10 0 Z`;
  await fixture('svg', `<svg viewBox='-10 -10 20 20'><path d='${d}'/></svg>`, file => {
    const m = fresh(40, 40); importSVG(m, file, {}); const area = Math.PI * 20 * 20;
    assert.ok(Math.abs(m.voxels.length - area) / area < 0.04, String(m.voxels.length));
  });
  await fixture('svg', "<svg viewBox='0 0 10 10'><path d='M0 10 Q5 -10 10 10 Z'/></svg>", file => {
    const m = fresh(); importSVG(m, file, {}); const area = 2 / 3 * 10 * 10;
    assert.ok(Math.abs(m.voxels.length - area) / area < 0.1, String(m.voxels.length));
  });
});

test('SVG fills: attribute, style, group inheritance, paint order and fill-rule evenodd', async () => {
  await fixture('svg', "<svg viewBox='0 0 10 10'><g fill='#0000ff'><rect width='10' height='10'/><rect x='2' y='2' width='4' height='4' style='fill:#ff0000'/><rect x='8' width='2' height='2' fill='none'/></g></svg>", file => {
    const m = fresh(); importSVG(m, file, {}); assert.equal(m.voxels.length, 100);
    assert.deepEqual(rgbOfIndex(m, cell(m, 3, 6)!.i), [255, 0, 0]); assert.deepEqual(rgbOfIndex(m, cell(m, 0, 0)!.i), [0, 0, 255]); assert.deepEqual(rgbOfIndex(m, cell(m, 9, 9)!.i), [0, 0, 255]);
  });
  const ring = 'M0 0H10V10H0Z M3 3H7V7H3Z';
  await fixture('svg', `<svg viewBox='0 0 10 10'><path d='${ring}' fill-rule='evenodd'/></svg>`, file => { const m = fresh(); importSVG(m, file, {}); assert.equal(m.voxels.length, 84); assert.ok(!cell(m, 5, 5)); });
  await fixture('svg', `<svg viewBox='0 0 10 10'><path d='${ring}'/></svg>`, file => { const m = fresh(); importSVG(m, file, {}); assert.equal(m.voxels.length, 100); });
});

test('SVG transforms: translate, scale, rotate, matrix and nested groups', async () => {
  await fixture('svg', "<svg viewBox='0 0 10 10'><g transform='translate(2 3)'><rect width='2' height='2'/></g></svg>", file => {
    const m = fresh(); importSVG(m, file, {});
    assert.deepEqual(m.voxels.map(v => [v.x, v.y]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!), [[2, 5], [2, 6], [3, 5], [3, 6]]);
  });
  await fixture('svg', "<svg viewBox='0 0 10 10'><g transform='translate(1,1)'><g transform='scale(2)'><rect width='2' height='2'/></g></g></svg>", file => {
    const m = fresh(); importSVG(m, file, {}); assert.equal(m.voxels.length, 16); assert.ok(m.voxels.every(v => v.x >= 1 && v.x < 5));
  });
  await fixture('svg', "<svg viewBox='0 0 10 10'><rect x='-2' y='-2' width='4' height='4' transform='translate(5 5) rotate(45)'/></svg>", file => {
    const m = fresh(); importSVG(m, file, {}); assert.ok(Math.abs(m.voxels.length - 16) <= 4, String(m.voxels.length));
    assert.ok(cell(m, 5, 5)); assert.ok(!cell(m, 1, 1)); assert.ok(!cell(m, 5, 8) && !cell(m, 5, 1));
  });
  await fixture('svg', "<svg viewBox='0 0 10 10'><rect width='2' height='2' transform='matrix(1 0 0 1 4 4)'/></svg>", file => {
    const m = fresh(); importSVG(m, file, {}); assert.equal(m.voxels.length, 4); assert.ok(cell(m, 4, 5) && cell(m, 5, 4));
  });
});

test('SVG ellipse, polygon, polyline and rounded rect are filled shapes; thickness extrudes along z', async () => fixture('svg',
  "<svg viewBox='0 0 10 10'><ellipse cx='5' cy='5' rx='4' ry='2'/><polygon points='0,0 2,0 2,2 0,2' fill='red'/><polyline points='8,8 10,8 10,10' fill='blue'/><rect x='3' y='8' width='4' height='2' rx='1' fill='green'/></svg>", file => {
    const m = fresh(10, 10, 3); importSVG(m, file, { thickness: 3 });
    assert.ok(m.voxels.some(v => v.z === 2) && m.voxels.every(v => v.z < 3));
    assert.ok(cell(m, 5, 4) && !cell(m, 0, 5)); assert.deepEqual(rgbOfIndex(m, cell(m, 0, 9)!.i), [255, 0, 0]);
    assert.deepEqual(rgbOfIndex(m, cell(m, 9, 1)!.i), [0, 0, 255]); assert.deepEqual(rgbOfIndex(m, cell(m, 5, 0)!.i), [0, 128, 0]);
    assert.ok(!cell(m, 3, 0) || rgbOfIndex(m, cell(m, 3, 0)!.i)[1] === 128);
  }));

test('SVG import into a model that already has voxels keeps the existing palette and voxels', async () => fixture('svg', "<svg viewBox='0 0 10 10'><rect width='2' height='2' fill='#ff0000'/></svg>", file => {
  const palette = new Uint32Array(256); palette[7] = 0xff0000ff; palette[8] = 0xff00ff00;
  const m: VoxModelData = { sizeX: 10, sizeY: 10, sizeZ: 1, palette, voxels: [{ x: 9, y: 9, z: 0, i: 8 }] }; importSVG(m, file, {});
  assert.equal(m.palette, palette); assert.equal(m.voxels.length, 5); assert.equal(cell(m, 0, 9)!.i, 7);
}));

test('OBJ resolves negative face indices, triangulates quads, converts Y-up and deduplicates', async () => fixture('obj', 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4/-1 -3/-1 -2/-1 -1/-1 # quad', async file => {
  const m: VoxModelData = { sizeX: 5, sizeY: 1, sizeZ: 5, voxels: [] }; const count = await importOBJ(m, file);
  assert.equal(count, 25); assert.equal(m.voxels.length, 25); assert.ok(m.voxels.some(v => v.x === 0 && v.z === 4)); assert.ok(m.voxels.every(v => v.y === 0));
  assert.equal(await importOBJ(m, file), 0);
}));

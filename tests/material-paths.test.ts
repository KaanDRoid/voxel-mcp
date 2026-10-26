import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { importOBJData } from '../src/importers.js';
import { unpackRGBA } from '../src/color.js';

function image(r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: 1, height: 1 }); png.data.set([r, g, b, 255]); return PNG.sync.write(png);
}

test('textures are relative to their material library rather than the OBJ directory', () => {
  const requests: string[] = [];
  const inputs = new Map<string, Buffer>([
    ['materials/model.mtl', Buffer.from('newmtl m\nKd 1 1 1\nmap_Kd tex.png\n')],
    ['materials/tex.png', image(255, 80, 20)],
    ['tex.png', image(20, 80, 255)],
  ]);
  const source = 'mtllib materials/model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0.5 0.5\nusemtl m\nf 1/1 2/1 3/1\n';
  const result = importOBJData(source, { axis: 'XYZ', fit: { max: 1 }, fill: 'surface', readAux: name => { requests.push(name.replaceAll('\\', '/')); return inputs.get(name.replaceAll('\\', '/')); } });
  assert.ok(result.voxels.length > 0);
  assert.deepEqual(requests, ['materials/model.mtl', 'materials/tex.png']);
  const color = unpackRGBA(result.palette![result.voxels[0]!.i]!);
  assert.deepEqual(color, { r: 255, g: 80, b: 20, a: 255 });
  assert.deepEqual(result.warnings.filter(w => /Texture/.test(w)), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { renderFrameToPNG, voxelColor, exportAnimationSpriteSheet } from '../src/animation.js';
import type { VoxModelData } from '../src/vox.js';

test('preview and sprite sheet use the same little-endian RGBA colors as VOX files', () => {
  const palette = new Uint32Array(256);
  palette[1] = 0xff1450ff;
  const model: VoxModelData = { sizeX: 2, sizeY: 2, sizeZ: 2, palette, voxels: [{ x: 0, y: 0, z: 0, i: 1 }] };
  assert.deepEqual(voxelColor(model, 1), [255, 80, 20, 255]);
  for (const projection of ['top', 'front', 'side', 'isometric'] as const) {
    const png = renderFrameToPNG(model, projection);
    const filled: number[][] = [];
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3]) filled.push([...png.data.subarray(i, i + 4)]);
    assert.ok(filled.length > 0);
    assert.ok(filled.every(rgba => rgba[0] === 255 && rgba[1] === 80 && rgba[2] === 20));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-color-'));
  try {
    const file = path.join(root, 'sheet.png');
    exportAnimationSpriteSheet([model], file);
    const png = PNG.sync.read(fs.readFileSync(file));
    const at = png.data.findIndex((v, i) => i % 4 === 3 && v === 255) - 3;
    assert.deepEqual([...png.data.subarray(at, at + 4)], [255, 80, 20, 255]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

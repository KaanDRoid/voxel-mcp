import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './helpers/sceneHarness.js';
import { createVOXScene, saveVOXScene } from '../src/scene.js';

test('multi-model scene import rolls back every registry insertion if capacity is exhausted', async () => {
  const h = harness();
  for (let i = 0; i < 63; i++) h.registry.create(1, 1, 1);
  const before = h.registry.list();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-atomic-'));
  try {
    const file = path.join(root, 'multi.vox');
    const model = { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] };
    saveVOXScene(file, createVOXScene([model, model]));
    await assert.rejects(h.call('load_vox_models', { path: file }), /limit|capacity/i);
    assert.deepEqual(h.registry.list(), before);
    assert.deepEqual(await h.call('list_scenes', {}), []);
    assert.equal(h.registry.create(1, 1, 1).id, '64');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

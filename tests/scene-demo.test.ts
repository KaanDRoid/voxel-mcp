import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { harness } from './helpers/sceneHarness.js';
import { loadVOXScene } from '../src/scene.js';

const demo = fileURLToPath(new URL('../examples/neon-alley/neon-alley-night.vox', import.meta.url));
test('the documented Neon Alley scene loads, edits and saves within bounded scene storage', async () => {
  const h = harness();
  const { sceneId } = await h.call('load_scene', { path: demo });
  const info = await h.call('get_scene_info', { sceneId });
  assert.equal(info.models[0].voxelCount, 316352);
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'Neon Alley checked' } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-demo-'));
  try {
    const target = path.join(root, 'scene.vox');
    await h.call('save_scene', { sceneId, path: target });
    const saved = loadVOXScene(target);
    assert.equal(saved.models[0]!.voxels.length, 316352);
    assert.equal(saved.nodes.find(n => n.id === 2)!.attributes._name, 'Neon Alley checked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('the documented Neon Alley model can create a new scene without bypassing allocation guards', async () => {
  const source = loadVOXScene(demo).models[0]!;
  const h = harness();
  const { id } = h.registry.create(source.sizeX, source.sizeY, source.sizeZ);
  h.registry.set(id, source);
  const { sceneId } = await h.call('create_scene', { modelIds: [id] });
  assert.equal((await h.call('get_scene_info', { sceneId })).models[0].voxelCount, 316352);
});

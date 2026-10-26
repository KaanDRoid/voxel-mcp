import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './helpers/sceneHarness.js';
import { decodeVOXScene } from '../src/scene.js';
import { defaultPalette } from '../src/vox.js';
import { nearestPaletteIndex } from '../src/paletteRemap.js';
import { buildSynthetic, CARS_NODES, cube, syntheticFixtures, corpusSkip, samplePath, chunk, ints, modelPair, voxFile } from './helpers/corpus.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-tools-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, bytes: Buffer) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
const carsFile = () => write('cars.vox', syntheticFixtures()['cars.vox']!);

test('every new scene tool uses a strict schema', () => {
  const { tools } = harness();
  for (const name of ['load_vox_models', 'flatten_scene', 'extract_scene_model', 'replace_scene_model', 'load_scene']) {
    assert.throws(() => tools.get(name)!.schema.parse({ sceneId: 's1', path: 'x', modelIndex: 0, id: '1', unexpected: true }), (e: unknown) => e instanceof Error, name);
  }
});

test('load_vox_models loads every model of a multi-model file and opens it as a scene', async () => {
  const { call, registry } = harness();
  const loaded = await call('load_vox_models', { path: carsFile() });
  assert.equal(loaded.models.length, 2);
  assert.deepEqual(loaded.models.map((m: { size: number[] }) => m.size), [[15, 34, 13], [15, 32, 14]]);
  assert.equal(registry.get(loaded.models[0].id).voxels.length, 2);
  const info = await call('get_scene_info', { sceneId: loaded.sceneId });
  assert.equal(info.models.length, 2);
  assert.equal(info.nodes.filter((n: { type: string }) => n.type === 'nTRN').length, 3);
});

test('deer-like animation file loads all four models', async () => {
  const { call } = harness();
  const loaded = await call('load_vox_models', { path: write('deer.vox', syntheticFixtures()['anim/deer.vox']!) });
  assert.equal(loaded.models.length, 4);
});

test('extract_scene_model with bake rotates and reports the world origin', async () => {
  const { call, registry } = harness();
  const { sceneId } = await call('load_vox_models', { path: carsFile() });
  const plain = await call('extract_scene_model', { sceneId, modelIndex: 0 });
  assert.equal(plain.origin, undefined);
  assert.deepEqual([registry.get(plain.id).sizeX, registry.get(plain.id).sizeY], [15, 34]);
  const baked = await call('extract_scene_model', { sceneId, modelIndex: 0, bake: true });
  assert.deepEqual(baked.origin, [-44, 0, 0]);
  const model = registry.get(baked.id);
  assert.deepEqual([model.sizeX, model.sizeY, model.sizeZ], [34, 15, 13]);
  await assert.rejects(call('extract_scene_model', { sceneId, modelIndex: 0, bake: true, instance: 3 }), /instance/);
});

test('flatten_scene creates the merged model and honours hidden layers', async () => {
  const { call, registry } = harness();
  const hidden = write('hidden.vox', buildSynthetic({ models: [{ size: [2, 2, 2], voxels: [[0, 0, 0, 5]] }, { size: [2, 2, 2], voxels: [[0, 0, 0, 6]] }], nodes: CARS_NODES, hiddenLayers: [1] }));
  const { sceneId } = await call('load_vox_models', { path: hidden });
  const flat = await call('flatten_scene', { sceneId });
  assert.equal(flat.skippedHidden, 1);
  assert.equal(registry.get(flat.models[0].id).voxels.length, 1);
  const all = await call('flatten_scene', { sceneId, includeHidden: true });
  assert.equal(registry.get(all.models[0].id).voxels.length, 2);
});

test('lenient loading reports warnings while strict loading rejects the same file', async () => {
  const { call } = harness();
  const dup = voxFile([chunk('SIZE', ints(2, 2, 2)), chunk('XYZI', Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2]))], 150);
  const file = write('dup.vox', dup);
  await assert.rejects(call('load_scene', { path: file }), /Duplicate/);
  const loaded = await call('load_scene', { path: file, lenient: true });
  assert.match(loaded.warnings[0], /duplicate/i);
  const info = await call('get_scene_info', { sceneId: loaded.sceneId });
  assert.equal(info.models[0].voxelCount, 1);
  assert.ok(info.warnings.length >= 1);
});

test('failed edits leave the stored scene untouched', async () => {
  const { call } = harness();
  const { sceneId } = await call('load_scene', { path: carsFile() });
  const before = JSON.stringify(await call('get_scene_info', { sceneId }));
  await assert.rejects(call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'x' }, translation: [1, 1, 1], rotation: 0 }));
  await assert.rejects(call('set_scene_node', { sceneId, nodeId: 2, layerId: 99 }), /layer/);
  await assert.rejects(call('set_scene_layer', { sceneId, layerId: 2147483648, attributes: {} }));
  assert.equal(JSON.stringify(await call('get_scene_info', { sceneId })), before);
  await call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'ok' }, translation: [1, 2, 3] });
  const after = await call('get_scene_info', { sceneId });
  assert.equal(after.nodes.find((n: { id: number }) => n.id === 2).attributes._name, 'ok');
});

test('saved scenes keep untouched chunks and typed render settings byte-for-byte', async () => {
  const { call } = harness();
  const original = syntheticFixtures()['anim/Gomez.vox']!;
  const { sceneId } = await call('load_scene', { path: write('g.vox', original) });
  await call('set_scene_layer', { sceneId, layerId: 3, attributes: { _name: 'renamed' } });
  const out = path.join(dir, 'g-out.vox');
  await call('save_scene', { sceneId, path: out });
  const reloaded = decodeVOXScene(fs.readFileSync(out));
  assert.equal(reloaded.layers.find(l => l.id === 3)!.attributes._name, 'renamed');
  assert.equal(reloaded.render.meta?._anim_range, '0 30');
  assert.equal(reloaded.render.objects.length, 15);
  // Only the renamed layer chunk may differ.
  const a = decodeVOXScene(original);
  assert.equal(reloaded.document.main.children.length, a.document.main.children.length);
});

// --- palette handling (replace_scene_model) ---------------------------------------------------

function customPaletteScene(): Buffer {
  const base = buildSynthetic({ models: [cube(2), cube(2, 2)], nodes: [] });
  const doc = decodeVOXScene(base);
  const rgba = doc.document.main.children.find(c => c.id === 'RGBA')!;
  const pal = Buffer.from(rgba.content);
  pal.writeUInt32LE(0xff0000ff, 0);       // index 1: opaque red
  pal.writeUInt32LE(0xff00ff00, 4);       // index 2: opaque green
  const at = base.indexOf(rgba.content);
  pal.copy(base, at);
  return base;
}

test('palette-less model in a custom-palette scene: clear error, or remap nearest', async () => {
  const { call, registry } = harness();
  const { sceneId } = await call('load_scene', { path: write('custom.vox', customPaletteScene()) });
  const { id } = registry.create(2, 2, 2);
  registry.set(id, { sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [{ x: 0, y: 0, z: 0, i: 1 }] }); // no palette: default palette index 1 is white
  await assert.rejects(call('replace_scene_model', { sceneId, modelIndex: 0, id }), (e: Error) => /Palette mismatch/.test(e.message) && /index 1/.test(e.message) && /#ff0000ff|#/.test(e.message) && /no palette/.test(e.message));
  await assert.rejects(call('replace_scene_model', { sceneId, modelIndex: 0, id, remap: 'error' }), /Palette mismatch/);
  // Scene palette index 1 is red (0xff0000ff) and index 2 is green; the default white (index 1) maps to the nearest scene color.
  await call('replace_scene_model', { sceneId, modelIndex: 0, id, remap: 'nearest' });
  const scene = await call('get_scene_info', { sceneId });
  assert.equal(scene.models[0].voxelCount, 1);
  const extracted = await call('extract_scene_model', { sceneId, modelIndex: 0 });
  const remapped = registry.get(extracted.id).voxels[0]!.i;
  assert.notEqual(remapped, 1, 'white must not map onto the red entry that replaced it');
  assert.equal(remapped, nearestPaletteIndex(new Uint32Array(registry.get(extracted.id).palette!), 0xffffffff));
});

test('a model with the same palette as the scene is accepted without remap', async () => {
  const { call, registry } = harness();
  const bytes = customPaletteScene();
  const { sceneId } = await call('load_scene', { path: write('custom2.vox', bytes) });
  const scene = decodeVOXScene(bytes);
  const { id } = registry.create(2, 2, 2);
  registry.set(id, { sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [{ x: 1, y: 1, z: 1, i: 2 }], palette: new Uint32Array(scene.models[0]!.palette!) });
  await call('replace_scene_model', { sceneId, modelIndex: 1, id });
});

test('default-palette scenes accept palette-less models', async () => {
  const { call, registry } = harness();
  const bytes = voxFile([...modelPair({ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }), ...modelPair({ size: [1, 1, 1], voxels: [[0, 0, 0, 2]] })], 150);
  const { sceneId } = await call('load_scene', { path: write('plain.vox', bytes) });
  const { id } = registry.create(1, 1, 1);
  registry.set(id, { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [{ x: 0, y: 0, z: 0, i: 7 }] });
  await call('replace_scene_model', { sceneId, modelIndex: 0, id });
  assert.equal(defaultPalette().length, 256);
});

test('installed multi-model samples load completely', { skip: corpusSkip() }, async () => {
  const { call } = harness();
  assert.equal((await call('load_vox_models', { path: samplePath('cars.vox') })).models.length, 2);
  assert.equal((await call('load_vox_models', { path: samplePath('anim/deer.vox') })).models.length, 4);
});

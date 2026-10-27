import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { harness } from './helpers/sceneHarness.js';
import { createVOXScene, decodeVOXScene, encodeVOXScene } from '../src/scene.js';
import { defaultPalette } from '../src/vox.js';

import { ModelRegistry } from '../src/model.js';
import { registerSceneTools } from '../src/sceneTools.js';

function limitedHarness(limits: Record<string, number>) {
  const registry = new ModelRegistry();
  const tools = new Map<string, { inputSchema: any; handler: any }>();
  registerSceneTools(((def: any, handler: any) => tools.set(def.name, { ...def, handler })) as never, registry, limits);
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!; const result = await tool.handler(tool.inputSchema.parse(args));
    return JSON.parse(result.content[0].text);
  };
  return { registry, call };
}

test('history bytes are bounded across undo and redo, with metadata counted', async () => {
  const h = limitedHarness({ historyLimit: 2, maxHistoryBytes: 16000 });
  const { id } = h.registry.create(1, 1, 1);
  const { sceneId } = await h.call('create_scene', { modelIds: [id] });
  for (let i = 0; i < 5; i++) await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: String(i) } });
  let count = 0; while ((await h.call('undo_scene', { sceneId })).undone) count++;
  assert.equal(count, 2);
  count = 0; while ((await h.call('redo_scene', { sceneId })).redone) count++;
  assert.equal(count, 2);
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'x'.repeat(4000) } });
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'y'.repeat(4000) } });
  assert.equal((await h.call('undo_scene', { sceneId })).undone, false, 'oversize metadata snapshot evicts itself and older history');
});

test('global storage counts other scenes and history; failed edit preserves scene and redo', async () => {
  const h = limitedHarness({ maxStorageBytes: 24000 });
  const { id } = h.registry.create(1, 1, 1);
  const { sceneId } = await h.call('create_scene', { modelIds: [id] });
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'edited' } });
  await h.call('undo_scene', { sceneId });
  const before = await h.call('get_scene_info', { sceneId });
  await assert.rejects(h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'x'.repeat(4000) } }), /storage/i);
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
  assert.equal((await h.call('redo_scene', { sceneId })).redone, true);
  await assert.rejects(h.call('create_scene', { modelIds: Array(6).fill(id) }), /storage/i);
  assert.equal((await h.call('undo_scene', { sceneId })).undone, true);
  const other = await h.call('create_scene', { modelIds: [id] });
  assert.equal(other.sceneId, 's2', 'failed creation does not consume a scene id');
  await assert.rejects(h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'one' } }).then(() => h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'two' } })), /storage/i);
  assert.equal((await h.call('undo_scene', { sceneId: other.sceneId })).undone, false);
});

test('every scene mutator participates in history and save/reload after undo restores exact scene bytes', async () => {
  const h = await setup(), { sceneId } = h;
  const replacement = h.registry.create(3, 1, 1);
  replacement.model.voxels.push({ x: 1, y: 0, z: 0, i: 2 });
  const edits: [string, Record<string, unknown>][] = [
    ['replace_scene_model', { modelIndex: 0, id: replacement.id }],
    ['set_scene_node', { nodeId: 2, translation: [9, 8, 7], attributes: { _name: 'renamed' } }],
    ['set_scene_layer', { layerId: 4, attributes: { _name: 'extra' } }],
    ['set_scene_material', { index: 1, properties: { _type: '_metal', _rough: '0.4' } }],
    ['set_scene_render_object', { type: '_inf', properties: { _int: '0.7' } }],
    ['set_scene_camera', { cameraId: 2, properties: { _fov: '55' } }],
    ['add_scene_object', { id: h.id, parentId: 1, layerId: 4, translation: [1, 2, 3] }],
    ['duplicate_scene_object', { nodeId: 2, parentId: 1 }],
    ['reparent_scene_object', { nodeId: 2 }],
    ['remove_scene_object', { nodeId: 2 }],
    ['delete_scene_layer', { layerId: 4, reassignTo: 0 }],
  ];
  const file = path.join(dir, 'history.vox');
  for (const [name, args] of edits) {
    await h.call('save_scene', { sceneId, path: file }); const before = fs.readFileSync(file);
    await h.call(name, { sceneId, ...args });
    await h.call('save_scene', { sceneId, path: file }); const after = fs.readFileSync(file);
    assert.notDeepEqual(after, before, name);
    assert.equal((await h.call('undo_scene', { sceneId })).undone, true, name);
    await h.call('save_scene', { sceneId, path: file }); assert.deepEqual(fs.readFileSync(file), before, name);
    assert.equal((await h.call('redo_scene', { sceneId })).redone, true, name);
    await h.call('save_scene', { sceneId, path: file }); assert.deepEqual(fs.readFileSync(file), after, name);
    const reloaded = await h.call('load_scene', { path: file });
    assert.deepEqual(await h.call('get_scene_info', { sceneId: reloaded.sceneId }), await h.call('get_scene_info', { sceneId }), name);
    assert.equal((await h.call('undo_scene', { sceneId: reloaded.sceneId })).undone, false);
    await h.call('delete_scene', { sceneId: reloaded.sceneId });
  }
});

test('add rejects palette mismatches and invalid parents/layers/translations without losing redo, nearest remap is copied', async () => {
  const h = await setup(), { sceneId } = h;
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'edited' } });
  await h.call('undo_scene', { sceneId });
  const before = await h.call('get_scene_info', { sceneId });
  const source = h.registry.create(1, 1, 1);
  source.model.palette = defaultPalette(); source.model.palette[1] = 0xff0000ff;
  source.model.voxels.push({ x: 0, y: 0, z: 0, i: 1 });
  await assert.rejects(h.call('add_scene_object', { sceneId, id: source.id }), /Palette mismatch.*index 1/);
  for (const args of [{ parentId: 2 }, { parentId: 999 }, { layerId: 999 }, { translation: [2147483648, 0, 0] }]) {
    await assert.rejects(h.call('add_scene_object', { sceneId, id: h.id, ...args }));
  }
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
  assert.equal((await h.call('redo_scene', { sceneId })).redone, true);
  const result = await h.call('add_scene_object', { sceneId, id: source.id, parentId: 1, remap: 'nearest' });
  const extracted = await h.call('extract_scene_model', { sceneId, modelIndex: result.modelIndex });
  assert.notEqual(h.registry.get(extracted.id).voxels[0]!.i, 1);
  assert.equal(source.model.voxels[0]!.i, 1);
});

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'scene-editing-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
async function setup() {
  const h = harness(); const { id } = h.registry.create(2, 2, 2);
  h.registry.get(id).voxels.push({ x: 0, y: 0, z: 0, i: 1 });
  const { sceneId } = await h.call('create_scene', { modelIds: [id] });
  return { ...h, id, sceneId };
}
test('wide shared graphs duplicate and remove without argument-stack overflow', async () => {
  const h = await setup(); const scene = createVOXScene([h.registry.get(h.id)]);
  scene.nodes = [
    { type: 'nGRP', id: 0, attributes: {}, children: Array(150_000).fill(1) },
    { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] },
  ];
  const file = path.join(dir, 'wide.vox'); fs.writeFileSync(file, encodeVOXScene(scene));
  const { sceneId } = await h.call('load_scene', { path: file });
  const result = await h.call('duplicate_scene_object', { sceneId, nodeId: 0 });
  assert.equal(result.nodeIds.length, 2);
  const info = await h.call('get_scene_info', { sceneId });
  const group = info.nodes.find((n: any) => n.id === result.nodeId);
  assert.equal(group.children.length, 150_000); assert.equal(new Set(group.children).size, 1);
  const removed = await h.call('remove_scene_object', { sceneId, nodeId: 0 });
  assert.deepEqual(removed.removedNodeIds, [0, 1]);
});

test('duplicate remaps all subtree node references, keeps shared descendants shared and keeps model references', async () => {
  const h = await setup();
  const duplicated = await h.call('duplicate_scene_object', { sceneId: h.sceneId, nodeId: 0 });
  const info = await h.call('get_scene_info', { sceneId: h.sceneId });
  assert.equal(info.models.length, 1); assert.equal(info.nodes.length, 8);
  const root = info.nodes.find((n: any) => n.id === duplicated.nodeId);
  assert.notEqual(root.childId, 1);
  const group = info.nodes.find((n: any) => n.id === root.childId);
  const transform = info.nodes.find((n: any) => n.id === group.children[0]);
  const shape = info.nodes.find((n: any) => n.id === transform.childId);
  assert.deepEqual(shape.models, [{ modelId: 0, attributes: {} }]);
  assert.equal(duplicated.nodeIds.length, 4);
  await assert.rejects(h.call('duplicate_scene_object', { sceneId: h.sceneId, nodeId: 99 }), /node/i);
});

test('remove retains externally referenced descendants and rejects removal of a transform child', async () => {
  const h = await setup();
  const scene = createVOXScene([h.registry.get(h.id)]);
  scene.nodes = [
    { type: 'nGRP', id: 0, attributes: {}, children: [1, 2] },
    { type: 'nTRN', id: 1, attributes: {}, childId: 3, layerId: -1, frames: [{}] },
    { type: 'nTRN', id: 2, attributes: {}, childId: 3, layerId: -1, frames: [{}] },
    { type: 'nGRP', id: 3, attributes: {}, children: [4] },
    { type: 'nSHP', id: 4, attributes: {}, models: [{ modelId: 0, attributes: {} }] },
  ];
  const file = path.join(dir, 'shared.vox'); fs.writeFileSync(file, encodeVOXScene(scene));
  const { sceneId } = await h.call('load_scene', { path: file });
  const copy = await h.call('duplicate_scene_object', { sceneId, nodeId: 0 });
  const copied = await h.call('get_scene_info', { sceneId });
  const copiedTransforms = copied.nodes.filter((n: any) => copy.nodeIds.includes(n.id) && n.type === 'nTRN');
  assert.equal(copiedTransforms[0].childId, copiedTransforms[1].childId);
  const removed = await h.call('remove_scene_object', { sceneId, nodeId: 1 });
  assert.deepEqual(removed.removedNodeIds, [1]);
  const before = await h.call('get_scene_info', { sceneId });
  assert.deepEqual(before.nodes.find((n: any) => n.id === 0).children, [2]);
  assert.ok(before.nodes.some((n: any) => n.id === 4));
  await assert.rejects(h.call('remove_scene_object', { sceneId, nodeId: 3 }), /transform/i);
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
  const last = await h.call('remove_scene_object', { sceneId, nodeId: 2 });
  assert.deepEqual(last.removedNodeIds.sort(), [2, 3, 4]);
  assert.equal((await h.call('get_scene_info', { sceneId })).models.length, 1);
});

test('reparent detaches group edges and rejects cycles atomically', async () => {
  const h = await setup(), { sceneId } = h;
  const { nodeId } = await h.call('duplicate_scene_object', { sceneId, nodeId: 1 });
  await h.call('reparent_scene_object', { sceneId, nodeId: 2, parentId: nodeId });
  let info = await h.call('get_scene_info', { sceneId });
  assert.deepEqual(info.nodes.find((n: any) => n.id === 1).children, []);
  assert.ok(info.nodes.find((n: any) => n.id === nodeId).children.includes(2));
  await assert.rejects(h.call('reparent_scene_object', { sceneId, nodeId, parentId: nodeId }), /cycl/i);
  await assert.rejects(h.call('reparent_scene_object', { sceneId, nodeId: 0, parentId: 1 }), /cycl/i);
  await assert.rejects(h.call('reparent_scene_object', { sceneId, nodeId: 3, parentId: 1 }), /transform/i);
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), info);
  await h.call('reparent_scene_object', { sceneId, nodeId: 2 });
  info = await h.call('get_scene_info', { sceneId });
  assert.ok(!info.nodes.find((n: any) => n.id === nodeId).children.includes(2));
});

test('used layers require explicit valid reassignment, unused layers can be deleted', async () => {
  const h = await setup(), { sceneId } = h;
  const before = await h.call('get_scene_info', { sceneId });
  await assert.rejects(h.call('delete_scene_layer', { sceneId, layerId: 0 }), /reassign/i);
  await assert.rejects(h.call('delete_scene_layer', { sceneId, layerId: 0, reassignTo: 99 }), /layer/i);
  await assert.rejects(h.call('delete_scene_layer', { sceneId, layerId: 0, reassignTo: 0 }), /layer/i);
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
  const result = await h.call('delete_scene_layer', { sceneId, layerId: 0, reassignTo: -1 });
  assert.equal(result.reassignedNodes, 1);
  const after = await h.call('get_scene_info', { sceneId });
  assert.equal(after.layers.length, 0); assert.equal(after.nodes.find((n: any) => n.id === 2).layerId, -1);
  await h.call('set_scene_layer', { sceneId, layerId: 7, attributes: {} });
  await h.call('delete_scene_layer', { sceneId, layerId: 7 });
});

test('scene undo/redo is isolated, repeatable, clears redo on edits and leaves history intact on failure', async () => {
  const h = await setup(), { sceneId } = h;
  const other = await h.call('create_scene', { modelIds: [h.id] });
  const before = await h.call('get_scene_info', { sceneId });
  assert.equal((await h.call('undo_scene', { sceneId })).undone, false);
  await h.call('set_scene_node', { sceneId, nodeId: 2, translation: [7, 8, 9] });
  const after = await h.call('get_scene_info', { sceneId });
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.call('undo_scene', { sceneId })).undone, true);
    assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
    await assert.rejects(h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'bad' }, layerId: 999 }), /layer/i);
    assert.equal((await h.call('redo_scene', { sceneId })).redone, true);
    assert.deepEqual(await h.call('get_scene_info', { sceneId }), after);
  }
  assert.equal((await h.call('undo_scene', { sceneId: other.sceneId })).undone, false);
  assert.deepEqual(await h.call('get_scene_info', { sceneId: other.sceneId }), before);
  await h.call('undo_scene', { sceneId });
  await h.call('set_scene_layer', { sceneId, layerId: 2, attributes: { _name: 'branch' } });
  assert.equal((await h.call('redo_scene', { sceneId })).redone, false);
  await h.call('delete_scene', { sceneId });
  await assert.rejects(h.call('undo_scene', { sceneId }), /not found/i);
});

test('add object copies registry geometry, places it and survives save/reload with unknown chunks', async () => {
  const h = await setup();
  const fixture = createVOXScene([h.registry.get(h.id)]);
  fixture.document.main.children.push({ id: 'UNKN', content: Buffer.from('opaque'), children: [{ id: 'CHLD', content: Buffer.from('nested'), children: [] }] });
  const input = path.join(dir, 'unknown.vox'); fs.writeFileSync(input, encodeVOXScene(fixture));
  const { sceneId } = await h.call('load_scene', { path: input });
  const result = await h.call('add_scene_object', { sceneId, id: h.id, translation: [3, -4, 5], layerId: -1 });
  assert.equal(result.modelIndex, 1); assert.equal(typeof result.nodeId, 'number');
  h.registry.get(h.id).voxels.length = 0;
  const output = path.join(dir, 'added.vox'); await h.call('save_scene', { sceneId, path: output });
  const saved = decodeVOXScene(fs.readFileSync(output));
  assert.equal(saved.models[1]!.voxels.length, 1);
  assert.equal(saved.nodes.find(n => n.id === result.nodeId && n.type === 'nTRN')?.type, 'nTRN');
  assert.equal(saved.document.main.children.find(c => c.id === 'UNKN')!.children[0]!.content.toString(), 'nested');
  const reopened = await h.call('load_scene', { path: output });
  assert.deepEqual(await h.call('get_scene_info', { sceneId: reopened.sceneId }), await h.call('get_scene_info', { sceneId }));
  for (let i = 0; i < 3; i++) {
    await h.call('undo_scene', { sceneId });
    await h.call('save_scene', { sceneId, path: output });
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input), 'undo restores original unknown chunks and geometry byte-for-byte');
    await h.call('redo_scene', { sceneId });
    await h.call('save_scene', { sceneId, path: output });
    const again = decodeVOXScene(fs.readFileSync(output));
    assert.deepEqual(again.document.main.children.find(c => c.id === 'UNKN'), saved.document.main.children.find(c => c.id === 'UNKN'));
  }
});

test('new scene schemas reject extra properties and custom limits reject unsafe values', () => {
  const h = harness();
  const args: Record<string, Record<string, unknown>> = {
    add_scene_object: { sceneId: 's1', id: '1' }, duplicate_scene_object: { sceneId: 's1', nodeId: 2 },
    remove_scene_object: { sceneId: 's1', nodeId: 2 }, reparent_scene_object: { sceneId: 's1', nodeId: 2 },
    delete_scene_layer: { sceneId: 's1', layerId: 0 }, undo_scene: { sceneId: 's1' }, redo_scene: { sceneId: 's1' },
  };
  for (const [name, input] of Object.entries(args)) {
    assert.ok(h.tools.get(name)!.schema.safeParse(input).success);
    assert.equal(h.tools.get(name)!.schema.safeParse({ ...input, unexpected: true }).success, false);
  }
  for (const value of [-1, 0.5, Infinity, NaN]) assert.throws(() => limitedHarness({ historyLimit: value }), /limits/);
});

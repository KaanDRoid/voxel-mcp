import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as editing from '../src/sceneEditing.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerSceneTools } from '../src/sceneTools.js';
import { ModelRegistry } from '../src/model.js';
import { createVOXScene, encodeVOXScene } from '../src/scene.js';
import type { VoxModelData } from '../src/vox.js';
import { harness } from './helpers/sceneHarness.js';

const model = (): VoxModelData => ({ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] });

test('model preflight counts repeated references and rejects before touching voxel elements', () => {
  const source = model(); source.sizeX = source.sizeY = source.sizeZ = 256;
  source.voxels.length = 100_000;
  Object.defineProperty(source.voxels, 0, { get() { throw new Error('voxel clone entered'); } });
  assert.throws(() => editing.preflightSceneModels(Array(64).fill(source)), /budget|resource|storage/i);
  assert.doesNotThrow(() => editing.preflightSceneModels([model()]));
  assert.throws(() => editing.preflightSceneModels([model()], 1), /budget|storage/i);
});

test('create_scene rejects repeated large registry references before cloning voxel input', async () => {
  const h = harness(); const { id, model: source } = h.registry.create(256, 256, 256);
  source.voxels.length = 100_000;
  Object.defineProperty(source.voxels, 0, { get() { throw new Error('voxel clone entered'); } });
  await assert.rejects(h.call('create_scene', { modelIds: Array(64).fill(id) }), /budget|resource|storage/i);
});

test('add rejects oversized input before any voxel clone or graph mutation', () => {
  const scene = createVOXScene([model()]); const before = structuredClone(scene);
  const source = model(); source.voxels.length = 1_000_000;
  Object.defineProperty(source.voxels, 0, { get() { throw new Error('voxel clone entered'); } });
  assert.throws(() => editing.addSceneObject(scene, source, { layerId: -1, translation: [0, 0, 0], remap: 'nearest' }), /budget|resource|storage/i);
  assert.deepEqual(structuredClone(scene), before);
});

test('duplicate rejects projected edge overflow before invoking structuredClone', () => {
  const scene = createVOXScene([model()]);
  scene.nodes = [{ type: 'nGRP', id: 0, attributes: {}, children: Array(210_000).fill(1) }, { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] }];
  const spy = mock.method(globalThis, 'structuredClone', () => { throw new Error('deep clone entered'); });
  try { assert.throws(() => editing.duplicateSceneObject(scene, 0), /resource|storage|budget/i); } finally { spy.mock.restore(); }
  assert.equal(scene.nodes.length, 2);
});

test('add reserves its new parent edge before cloning input', () => {
  const scene = createVOXScene([model()]);
  scene.nodes = [{ type: 'nGRP', id: 0, attributes: {}, children: Array(399_999).fill(1) }, { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] }];
  const source = model();
  Object.defineProperty(source.voxels, 'map', { configurable: true, value: () => { throw new Error('voxel clone entered'); } });
  assert.throws(() => editing.addSceneObject(scene, source, { parentId: 0, layerId: -1, translation: [0, 0, 0], remap: 'nearest' }), /resource|storage|budget/i);
  assert.equal(scene.nodes.length, 2);
});

test('load rejects object-heavy frame tables before the decoder serializes metadata', async () => {
  const scene = createVOXScene([model()]);
  scene.nodes = [{ type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames: Array.from({ length: 65_537 }, () => ({})) }, { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-allocation-'));
  const file = path.join(dir, 'frames.vox'); fs.writeFileSync(file, encodeVOXScene(scene));
  const h = harness(), tool = h.tools.get('load_scene')!;
  const args = tool.schema.parse({ path: file });
  const spy = mock.method(JSON, 'stringify', () => { throw new Error('decoder metadata allocation entered'); });
  try { await assert.rejects(tool.handler(args as never), /resource|budget|storage/i); }
  finally { spy.mock.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('create and load enforce capacity before model copies or file reads', async () => {
  const registry = new ModelRegistry(), { id, model: source } = registry.create(1, 1, 1);
  Object.defineProperty(source.voxels, 'map', { value: () => { throw new Error('model clone entered'); } });
  const tools = new Map<string, { inputSchema: { parse(input: unknown): unknown }; handler: (args: never) => Promise<unknown> }>();
  const register = (definition: { name: string; inputSchema: { parse(input: unknown): unknown } }, handler: (args: never) => Promise<unknown>) => { tools.set(definition.name, { ...definition, handler }); };
  registerSceneTools(register as never, registry, { maxStorageBytes: 1 });
  let tool = tools.get('create_scene')!;
  await assert.rejects(tool.handler(tool.inputSchema.parse({ modelIds: [id] }) as never), /storage/);
  registerSceneTools(register as never, registry, { maxScenes: 0 });
  tool = tools.get('load_scene')!;
  const args = tool.inputSchema.parse({ path: 'not-opened.vox' });
  const spy = mock.method(fs, 'readFileSync', () => { throw new Error('file read entered'); });
  try { await assert.rejects(tool.handler(args as never), /Scene limit/); } finally { spy.mock.restore(); }
});

test('add checks global storage including history before cloning the registry model', async () => {
  const registry = new ModelRegistry(), { id } = registry.create(1, 1, 1);
  const tools = new Map<string, { inputSchema: { parse(input: unknown): unknown }; handler: (args: never) => Promise<{ content: { text: string }[] }> }>();
  registerSceneTools(((definition: { name: string; inputSchema: { parse(input: unknown): unknown } }, handler: (args: never) => Promise<{ content: { text: string }[] }>) => { tools.set(definition.name, { ...definition, handler }); }) as never, registry, { maxStorageBytes: 14_000 });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!; return JSON.parse((await tool.handler(tool.inputSchema.parse(args) as never)).content[0]!.text);
  };
  const { sceneId } = await call('create_scene', { modelIds: [id] });
  await call('create_scene', { modelIds: [id] });
  const source = registry.create(1, 1, 1);
  Object.defineProperty(source.model.voxels, 'map', { value: () => { throw new Error('model clone entered'); } });
  await assert.rejects(call('add_scene_object', { sceneId, id: source.id }), /storage/);
  assert.equal((await call('get_scene_info', { sceneId })).models.length, 1);
});

test('ordinary commits reject oversized merged dictionaries without losing redo', async () => {
  const h = harness(), { id } = h.registry.create(1, 1, 1);
  const { sceneId } = await h.call('create_scene', { modelIds: [id] });
  for (let group = 0; group < 3; group++) {
    const attributes = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${group * 64 + i}`, '']));
    await h.call('set_scene_node', { sceneId, nodeId: 2, attributes });
  }
  await h.call('set_scene_node', { sceneId, nodeId: 2, attributes: { marker: 'future' } });
  await h.call('undo_scene', { sceneId });
  const before = await h.call('get_scene_info', { sceneId });
  const attributes = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${192 + i}`, '']));
  await assert.rejects(h.call('set_scene_node', { sceneId, nodeId: 2, attributes }), /property.*resource/);
  assert.deepEqual(await h.call('get_scene_info', { sceneId }), before);
  assert.equal((await h.call('redo_scene', { sceneId })).redone, true);
});

test('hard graph and dictionary counts reject sparse inputs before inspecting their elements', () => {
  const fail = () => { throw new Error('oversized elements inspected'); };
  const sparse = <T>(length: number): T[] => {
    const values = Array<T>(length); Object.defineProperty(values, 0, { get: fail }); return values;
  };
  const scene = createVOXScene([model()]);
  scene.nodes = sparse(16_385);
  assert.throws(() => editing.sceneStorageBytes(scene), /resource/);
  scene.nodes = [{ type: 'nGRP', id: 0, attributes: {}, children: sparse(400_001) }];
  assert.throws(() => editing.sceneStorageBytes(scene), /edge.*resource/);
  scene.nodes = [{ type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames: sparse(65_537) }];
  assert.throws(() => editing.sceneStorageBytes(scene), /frame.*resource/);
  scene.nodes = [{ type: 'nSHP', id: 0, attributes: {}, models: sparse(65_537) }];
  assert.throws(() => editing.sceneStorageBytes(scene), /track.*resource/);
  const attributes: Record<string, string> = {};
  for (let i = 0; i < 256; i++) attributes[`p${i}`] = '';
  Object.defineProperty(attributes, 'overflow', { enumerable: true, get: fail });
  scene.nodes = [{ type: 'nGRP', id: 0, attributes, children: [] }];
  assert.throws(() => editing.sceneStorageBytes(scene), /property.*resource/);
  scene.nodes = [];
  scene.document.main.children = sparse(32_769);
  assert.throws(() => editing.sceneStorageBytes(scene), /resource/);
});

test('aggregate properties and frames are bounded even with an explicitly large storage budget', () => {
  const scene = createVOXScene([model()]);
  const attributes = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, '']));
  scene.nodes = [{ type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames: Array(1025).fill(attributes) }];
  assert.throws(() => editing.sceneStorageBytes(scene, Number.MAX_SAFE_INTEGER), /property.*resource/);
  scene.nodes = [0, 1].map(id => ({ type: 'nTRN', id, attributes: {}, childId: 2, layerId: -1, frames: Array(40_000).fill({}) }));
  assert.throws(() => editing.sceneStorageBytes(scene, Number.MAX_SAFE_INTEGER), /frame.*resource/);
});

test('storage charges empty frame objects conservatively without serializing metadata', () => {
  const scene = createVOXScene([model()]);
  scene.nodes = [{ type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames: Array.from({ length: 1000 }, () => ({})) }];
  const spy = mock.method(JSON, 'stringify', () => { throw new Error('serialization entered'); });
  try { assert.ok(editing.sceneStorageBytes(scene) >= 80_000); } finally { spy.mock.restore(); }
});

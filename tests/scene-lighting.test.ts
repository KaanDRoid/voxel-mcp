import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ModelRegistry } from '../src/model.js';
import { registerSceneTools } from '../src/sceneTools.js';
import { createVOXScene, decodeVOXScene, encodeVOXScene } from '../src/scene.js';
import { defaultPalette } from '../src/vox.js';

const observedTypes = ['_bounce', '_env', '_inf', '_uni', '_ibl', '_atm', '_fog_uni', '_lens', '_film', '_bloom', '_ground', '_bg', '_edge', '_grid', '_setting'];

function harness() {
  const registry = new ModelRegistry();
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: (args: never) => Promise<CallToolResult> }>();
  registerSceneTools((definition, handler) => {
    tools.set(definition.name, { schema: definition.inputSchema, handler });
  }, registry);
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.handler(tool.schema.parse(args) as never);
    const content = result.content[0];
    assert.ok(content?.type === 'text');
    return JSON.parse(content.text);
  };
  return { registry, tools, call };
}

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-lighting-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness();
  const { id } = h.registry.create(4, 4, 4);
  h.registry.set(id, { sizeX: 4, sizeY: 4, sizeZ: 4, palette: defaultPalette(), voxels: [{ x: 1, y: 2, z: 3, i: 20 }] });
  const scene = createVOXScene([h.registry.get(id)]);
  scene.nodes.push({ type: 'nSHP', id: 0, attributes: { _name: 'Street' }, models: [{ modelId: 0, attributes: {} }] });
  scene.materials.push({ id: 20, attributes: { _type: '_emit', _emit: '1.0', _future_material: 'kept' } });
  scene.render.objects.push({ type: '_uni', attributes: { _type: '_uni', _i: '0.59', _k: '177 218 255', _future: 'kept' } });
  scene.render.objects.push({ type: '_future_renderer', attributes: { _type: '_future_renderer', _opaque: 'untouched' } });
  scene.render.cameras.push({ id: 0, attributes: { _mode: 'pers', _fov: '45', _future_camera: 'kept' } });
  scene.render.notes = ['neon'];
  scene.render.imap = Array.from({ length: 256 }, (_, i) => i);
  scene.render.meta = { _future_meta: 'kept' };
  scene.document.main.children.push({ id: 'XTRA', content: Buffer.from([0, 255, 42]), children: [{ id: 'MORE', content: Buffer.from('untouched'), children: [] }] });
  const input = path.join(root, 'input.vox');
  fs.writeFileSync(input, encodeVOXScene(scene));
  const original = decodeVOXScene(fs.readFileSync(input));
  const { sceneId } = await h.call('load_scene', { path: input });
  const save = async () => {
    const output = path.join(root, 'output.vox');
    await h.call('save_scene', { sceneId, path: output });
    const bytes = fs.readFileSync(output);
    return { bytes, scene: decodeVOXScene(bytes) };
  };
  return { ...h, sceneId, original, save };
}

function assertUntouched(original: ReturnType<typeof decodeVOXScene>, edited: ReturnType<typeof decodeVOXScene>, changed: 'rOBJ' | 'rCAM') {
  assert.deepEqual(edited.models, original.models);
  assert.deepEqual(edited.nodes, original.nodes);
  assert.deepEqual(edited.layers, original.layers);
  assert.deepEqual(edited.materials, original.materials);
  assert.deepEqual(
    edited.document.main.children.filter(c => c.id !== changed),
    original.document.main.children.filter(c => c.id !== changed),
    'untouched chunks retain their order and exact contents',
  );
}

test('set_scene_render_object creates and merges all observed types with disk round-trip preservation', async t => {
  const { call, sceneId, original, save } = await fixture(t);
  await save(); // Populate the serialization cache before editing.
  for (const type of observedTypes) {
    assert.deepEqual(await call('set_scene_render_object', { sceneId, type, properties: { _i: '0.25' } }), { sceneId, type });
    await call('set_scene_render_object', { sceneId, type, properties: { _type: type, _custom: 'second edit' } });
  }
  const { scene } = await save();
  for (const type of observedTypes) {
    const objects = scene.render.objects.filter(o => o.type === type);
    assert.equal(objects.length, 1, `${type} is not duplicated`);
    assert.equal(objects[0]!.attributes._type, type);
    assert.equal(objects[0]!.attributes._i, '0.25');
    assert.equal(objects[0]!.attributes._custom, 'second edit');
  }
  assert.equal(scene.render.objects.find(o => o.type === '_uni')!.attributes._future, 'kept');
  assert.equal(scene.render.objects.find(o => o.type === '_uni')!.attributes._k, '177 218 255');
  assert.deepEqual(scene.render.objects.find(o => o.type === '_future_renderer'), original.render.objects[1]);
  assertUntouched(original, scene, 'rOBJ');
});

test('set_scene_camera creates and merges camera slots 0 through 9 without duplicates', async t => {
  const { call, sceneId, original, save } = await fixture(t);
  await save();
  for (let cameraId = 0; cameraId <= 9; cameraId++) {
    assert.deepEqual(await call('set_scene_camera', { sceneId, cameraId, properties: { _mode: 'pers', _focus: '0 0 0', _angle: '0 0 0', _radius: '0', _frustum: '0.414214', _fov: '45' } }), { sceneId, cameraId });
    await call('set_scene_camera', { sceneId, cameraId, properties: { _fov: '60' } });
  }
  const { scene } = await save();
  assert.equal(scene.render.cameras.length, 10);
  for (let cameraId = 0; cameraId <= 9; cameraId++) {
    const cameras = scene.render.cameras.filter(c => c.id === cameraId);
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0]!.attributes._fov, '60');
    assert.equal(cameras[0]!.attributes._focus, '0 0 0');
    assert.equal(cameras[0]!.attributes._frustum, '0.414214');
  }
  assert.equal(scene.render.cameras[0]!.attributes._future_camera, 'kept');
  assertUntouched(original, scene, 'rCAM');
});

test('set_scene_render_object rejects conflicting _type before changing scene state', async t => {
  const { call, sceneId, save } = await fixture(t);
  const before = (await save()).bytes;
  for (const type of ['_uni', '_film']) {
    await assert.rejects(call('set_scene_render_object', { sceneId, type, properties: { _type: '_bloom', _i: '99' } }), /_type.*match|match.*_type/);
    assert.deepEqual((await save()).bytes, before);
  }
});

for (const name of ['set_scene_render_object', 'set_scene_camera']) {
  test(`${name} rejects invalid arguments and missing scenes without changing stored bytes`, async t => {
    const { call, sceneId, save } = await fixture(t);
    const valid = name === 'set_scene_render_object' ? { sceneId, type: '_uni', properties: {} } : { sceneId, cameraId: 0, properties: {} };
    const before = (await save()).bytes;
    const invalid: Record<string, unknown>[] = [
      { ...valid, unexpected: true },
      { ...valid, sceneId: 123 },
      { ...valid, properties: { _i: 1 } },
      { ...valid, properties: { ['k'.repeat(129)]: 'value' } },
      { ...valid, properties: { _custom: 'v'.repeat(4097) } },
      { ...valid, properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v'])) },
      { ...valid, properties: undefined },
    ];
    if (name === 'set_scene_render_object') {
      for (const type of ['_unknown', '', 1, undefined]) invalid.push({ ...valid, type });
    } else {
      for (const cameraId of [-1, 10, 0.5, '0', undefined]) invalid.push({ ...valid, cameraId });
    }
    for (const args of invalid) {
      await assert.rejects(call(name, args), { name: 'ZodError' });
      assert.deepEqual((await save()).bytes, before);
    }
    await assert.rejects(call(name, { ...valid, sceneId: 'missing' }), /Scene missing not found/);
    assert.deepEqual((await save()).bytes, before);
    await call(name, { ...valid, properties: { ['k'.repeat(128)]: 'v'.repeat(4096) } });
    await call(name, { ...valid, properties: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, 'v'])) });
    const after = await save();
    assert.notDeepEqual(after.bytes, before);
  });
}

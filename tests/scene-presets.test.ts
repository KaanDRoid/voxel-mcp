import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { cloneScene, createVOXScene, decodeVOXScene, encodeVOXScene, validateScene } from '../src/scene.js';

async function harness(rejectCommit = false) {
  const module = await import('../src/scenePresets.js');
  assert.ok(module.registerScenePresetTools, 'registerScenePresetTools must exist');
  let scene = createVOXScene([{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [{ x: 0, y: 0, z: 0, i: 1 }] }]);
  let commits = 0;
  const tools = new Map<string, { schema: z.ZodType; handler: (args: never) => Promise<CallToolResult> }>();
  module.registerScenePresetTools((definition, handler) => {
    tools.set(definition.name, { schema: definition.inputSchema, handler: handler as (args: never) => Promise<CallToolResult> });
  }, {
    get(id) { assert.equal(id, 's1'); return cloneScene(scene); },
    commit(next, id) {
      assert.equal(id, 's1');
      if (rejectCommit) throw new Error('Scene storage limit exceeded');
      validateScene(next); scene = next; commits++; return id;
    },
  });
  return {
    module, tools, get scene() { return scene; }, get commits() { return commits; },
    async call(name: string, args: Record<string, unknown>) {
      const tool = tools.get(name);
      assert.ok(tool, `Missing tool ${name}`);
      return tool.handler(tool.schema.parse(args) as never);
    },
  };
}

test('typed material updates native attributes and preserves unknown metadata', async () => {
  const h = await harness();
  h.scene.materials.push({ id: 7, attributes: { _custom: 'untouched', _rough: '0.10' } });
  await h.call('set_scene_material_properties', { sceneId: 's1', index: 7, type: 'metal', roughness: 0.25, metalness: 0.8, ior: 0.3 });
  assert.deepEqual(h.scene.materials[0], { id: 7, attributes: { _custom: 'untouched', _rough: '0.25', _type: '_metal', _metal: '0.8', _ior: '0.3' } });
  assert.equal(h.commits, 1);
  const decoded = decodeVOXScene(encodeVOXScene(h.scene));
  assert.deepEqual({ ...decoded.materials[0]!.attributes }, h.scene.materials[0]!.attributes);
});

test('emission metadata supports all documented material types without inventing physical units', async () => {
  const h = await harness();
  for (const [index, type] of ['diffuse', 'metal', 'glass', 'emit'].entries()) {
    await h.call('set_scene_material_properties', { sceneId: 's1', index: index + 1, type, ...(type === 'emit' ? { emission: 1, flux: 2 } : {}) });
    assert.equal(h.scene.materials[index]!.attributes._type, `_${type}`);
  }
  assert.equal(h.scene.materials[3]!.attributes._emit, '1');
  assert.equal(h.scene.materials[3]!.attributes._flux, '2');
});

test('material schema rejects contradictions, unknown keys and non-finite or out-of-policy numbers before commit', async () => {
  const h = await harness();
  const before = encodeVOXScene(h.scene);
  const base = { sceneId: 's1', index: 1, type: 'diffuse' };
  for (const patch of [
    { metalness: 0.5 }, { emission: 0.2 }, { flux: 2 },
    { properties: { _type: '_metal' } }, { _type: '_metal' },
    { index: 0 }, { index: 257 }, { roughness: -0.1 }, { roughness: 1.1 },
    { ior: 1.3 }, { roughness: NaN }, { roughness: Infinity }, { roughness: '0.5' },
    { type: 'emit', flux: 5 }, { type: 'emit', emission: Infinity },
  ]) {
    await assert.rejects(h.call('set_scene_material_properties', { ...base, ...patch }));
  }
  assert.equal(h.commits, 0);
  assert.deepEqual(encodeVOXScene(h.scene), before);
});

test('studio/daylight/night presets merge deterministic native rOBJ settings while preserving other state', async () => {
  const expected = {
    studio: { key: '0.6', ambient: '0.7', color: '255 255 255' },
    daylight: { key: '1', ambient: '0.59', color: '177 218 255' },
    night: { key: '0.1', ambient: '0.1', color: '177 218 255' },
  };
  for (const preset of ['studio', 'daylight', 'night'] as const) {
    const h = await harness();
    h.scene.render.objects.push(
      { type: '_uni', attributes: { _type: '_uni', _custom: 'keep' } },
      { type: '_film', attributes: { _type: '_film', _custom: 'unrelated' } },
    );
    await h.call('apply_scene_lighting_preset', { sceneId: 's1', preset });
    const inf = h.scene.render.objects.find(o => o.type === '_inf')!;
    const uni = h.scene.render.objects.find(o => o.type === '_uni')!;
    assert.equal(inf.attributes._i, expected[preset].key);
    assert.equal(inf.attributes._type, '_inf');
    assert.equal(uni.attributes._i, expected[preset].ambient);
    assert.equal(uni.attributes._k, expected[preset].color);
    assert.equal(uni.attributes._custom, 'keep');
    assert.equal(h.scene.render.objects.find(o => o.type === '_film')!.attributes._custom, 'unrelated');
    assert.equal(h.commits, 1);
    const once = encodeVOXScene(h.scene);
    await h.call('apply_scene_lighting_preset', { sceneId: 's1', preset });
    assert.deepEqual(encodeVOXScene(h.scene), once);
  }
});

test('camera pose writes verified native fields into one slot and preserves opaque attributes', async () => {
  const h = await harness();
  h.scene.render.cameras.push({ id: 3, attributes: { _custom: 'keep', _frustum: '0.414214', _mode: 'pers' } }, { id: 8, attributes: { _custom: 'other slot' } });
  const untouched = JSON.stringify(h.scene.render.cameras[1]);
  await h.call('set_scene_camera_pose', { sceneId: 's1', cameraId: 3, focus: [1.5, -2, 3], angle: [20, 30, -10], radius: 80, fov: 45, projection: 'perspective' });
  assert.deepEqual(h.scene.render.cameras[0], { id: 3, attributes: { _custom: 'keep', _frustum: '0.414214', _mode: 'pers', _focus: '1.5 -2 3', _angle: '20 30 -10', _radius: '80', _fov: '45' } });
  assert.equal(JSON.stringify(h.scene.render.cameras[1]), untouched);
  const decoded = decodeVOXScene(encodeVOXScene(h.scene));
  assert.deepEqual({ ...decoded.render.cameras[0]!.attributes }, h.scene.render.cameras[0]!.attributes);
  assert.equal(h.commits, 1);
  await h.call('set_scene_camera_pose', { sceneId: 's1', cameraId: 0, focus: [0, 0, 0], angle: [0, 0, 0], radius: 0, fov: 45 });
  assert.equal(h.scene.render.cameras.find(c => c.id === 0)!.attributes._mode, 'pers');
});

test('exported tool-name catalog matches registered tools with strict schemas', async () => {
  const h = await harness();
  assert.deepEqual(h.module.SCENE_PRESET_TOOL_NAMES, [
    'set_scene_material_properties', 'apply_scene_lighting_preset', 'set_scene_camera_pose',
  ]);
  assert.deepEqual([...h.tools.keys()], h.module.SCENE_PRESET_TOOL_NAMES);
  for (const tool of h.tools.values()) assert.equal(z.toJSONSchema(tool.schema).additionalProperties, false);
});

test('camera rejects non-finite values, fractional integer fields and unverified projection names without mutation', async () => {
  const h = await harness();
  const before = encodeVOXScene(h.scene);
  const base = { sceneId: 's1', cameraId: 0, focus: [0, 0, 0], angle: [0, 0, 0], radius: 1, fov: 45 };
  for (const patch of [
    { cameraId: -1 }, { cameraId: 10 }, { cameraId: 0.5 },
    { focus: [Infinity, 0, 0] }, { focus: [1_000_001, 0, 0] }, { focus: [0, 0] },
    { angle: [0, NaN, 0] }, { angle: [0, 361, 0] }, { angle: [0, 0, 0, 0] },
    { radius: -1 }, { radius: 1.5 }, { radius: 1_000_001 }, { radius: Infinity },
    { fov: 0 }, { fov: 180 }, { fov: 45.5 }, { fov: NaN },
    { projection: 'orthographic' }, { projection: 'pers' }, { projection: 'unknown' },
    { properties: { _mode: 'orth' } }, { _fov: '45' },
  ]) await assert.rejects(h.call('set_scene_camera_pose', { ...base, ...patch }));
  assert.equal(h.commits, 0);
  assert.deepEqual(encodeVOXScene(h.scene), before);
});

test('lighting presets reject unknown presets and raw metadata overrides without mutation', async () => {
  const h = await harness();
  const before = encodeVOXScene(h.scene);
  for (const args of [
    { preset: 'sunset' }, { preset: 'studio', _type: '_film' },
    { preset: 'studio', properties: { _i: 'Infinity' } },
  ]) await assert.rejects(h.call('apply_scene_lighting_preset', { sceneId: 's1', ...args }));
  assert.equal(h.commits, 0);
  assert.deepEqual(encodeVOXScene(h.scene), before);
});

test('failed commit discards every preset edit', async () => {
  const h = await harness(true);
  const before = encodeVOXScene(h.scene);
  for (const [name, args] of [
    ['set_scene_material_properties', { sceneId: 's1', index: 1, type: 'emit', emission: 1 }],
    ['apply_scene_lighting_preset', { sceneId: 's1', preset: 'night' }],
    ['set_scene_camera_pose', { sceneId: 's1', cameraId: 0, focus: [0, 0, 0], angle: [0, 0, 0], radius: 0, fov: 45 }],
  ] as const) {
    await assert.rejects(h.call(name, args), /storage limit/);
    assert.deepEqual(encodeVOXScene(h.scene), before);
  }
  assert.equal(h.commits, 0);
});

test('handlers independently validate raw calls before editing', async () => {
  const h = await harness();
  for (const [name, args] of [
    ['set_scene_material_properties', { sceneId: 's1', index: 1, type: 'diffuse', emission: 1 }],
    ['apply_scene_lighting_preset', { sceneId: 's1', preset: 'bad' }],
    ['set_scene_camera_pose', { sceneId: 's1', cameraId: 0, focus: [0, 0, 0], angle: [0, 0, 0], radius: NaN, fov: 45 }],
  ] as const) await assert.rejects(h.tools.get(name)!.handler(args as never));
  assert.equal(h.commits, 0);
});

test('numeric policy boundaries round-trip and omitted material values and camera mode survive', async () => {
  const h = await harness();
  h.scene.materials.push({ id: 256, attributes: { _rough: '0.10', _ri: '1.3', _custom: 'keep' } });
  await h.call('set_scene_material_properties', { sceneId: 's1', index: 256, type: 'emit', emission: 0, flux: 4 });
  assert.deepEqual(h.scene.materials[0]!.attributes, { _rough: '0.10', _ri: '1.3', _custom: 'keep', _type: '_emit', _emit: '0', _flux: '4' });
  h.scene.render.cameras.push({ id: 9, attributes: { _mode: 'opaque-future-mode' } });
  await h.call('set_scene_camera_pose', { sceneId: 's1', cameraId: 9, focus: [-1_000_000, 0, 1_000_000], angle: [-360, 0, 360], radius: 1_000_000, fov: 179 });
  assert.equal(h.scene.render.cameras[0]!.attributes._mode, 'opaque-future-mode');
  const decoded = decodeVOXScene(encodeVOXScene(h.scene));
  assert.equal(decoded.render.cameras[0]!.attributes._radius, '1000000');
  assert.equal(decoded.materials[0]!.attributes._flux, '4');
});

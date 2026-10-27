import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ModelRegistry } from '../src/model.js';
import { AnimationRegistry } from '../src/animation.js';
import { cloneScene, createVOXScene, decodeVOXScene, encodeVOXScene, saveVOXScene, validateScene } from '../src/scene.js';
import type { VoxScene, VoxDictionary } from '../src/scene.js';
import { registerSceneAnimationTools, SCENE_ANIMATION_TOOL_NAMES } from '../src/sceneAnimation.js';
import { chunk, dict, ints, modelPair, voxFile } from './helpers/corpus.js';

const model = () => ({ sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [{ x: 0, y: 0, z: 0, i: 1 }] });
function fixture(): VoxScene {
  const s = createVOXScene([model(), model()]);
  s.nodes = [
    { type: 'nTRN', id: 0, attributes: { _name: 'Object', custom: 'keep' }, childId: 1, layerId: -1, frames: [{ _t: '0 0 0', custom: 'frame' }] },
    { type: 'nSHP', id: 1, attributes: { custom: 'shape' }, models: [{ modelId: 0, attributes: { custom: 'model' } }] },
  ];
  s.document.main.children.push({ id: 'TEST', content: Buffer.from([1, 2, 3]), children: [] });
  return decodeVOXScene(encodeVOXScene(s));
}
function harness(initial = fixture(), animations?: AnimationRegistry) {
  const scenes = new Map<string, VoxScene>([['s1', initial]]);
  const registry = new ModelRegistry();
  const tools = new Map<string, { schema: z.ZodType; handler: (args: any) => Promise<CallToolResult> }>();
  let commits = 0;
  registerSceneAnimationTools((definition, handler) => { tools.set(definition.name, { schema: definition.inputSchema, handler }); }, {
    peek(id) { const s = scenes.get(id); if (!s) throw new Error('Scene not found'); return s; },
    get(id) { const s = scenes.get(id); if (!s) throw new Error('Scene not found'); return cloneScene(s); },
    commit(scene, id) { validateScene(scene); commits++; const key = id ?? `s${scenes.size + 1}`; scenes.set(key, scene); return key; },
  }, registry, animations);
  return { scenes, registry, tools, commits: () => commits,
    async call(name: string, args: unknown = {}): Promise<any> {
      const tool = tools.get(name); assert.ok(tool, `Missing tool ${name}`);
      const result = await tool.handler(tool.schema.parse(args));
      assert.ok(!result.isError, JSON.stringify(result));
      const block = result.content?.[0]; assert.equal(block?.type, 'text');
      return JSON.parse((block as { text: string }).text);
    },
  };
}

test('direct handlers validate strict schemas before touching scene or registries', async () => {
  const tools = new Map<string, (args: any) => Promise<CallToolResult>>();
  const touches: string[] = [];
  const registry = new ModelRegistry();
  const animations = new AnimationRegistry();
  registry.get = () => { touches.push('model'); throw new Error('Model lookup'); };
  animations.getData = () => { touches.push('animation'); throw new Error('Animation lookup'); };
  registerSceneAnimationTools((definition, handler) => { tools.set(definition.name, handler); }, {
    peek() { touches.push('peek'); throw new Error('Scene read'); },
    get() { touches.push('get'); throw new Error('Scene clone'); },
    commit() { touches.push('commit'); throw new Error('Commit'); },
  }, registry, animations);
  const valid: Record<string, Record<string, unknown>> = {
    inspect_scene_animation: { sceneId: 's1' },
    set_scene_transform_keyframe: { sceneId: 's1', nodeId: 0, frameIndex: 0, rotation: 4 },
    set_scene_model_keyframe: { sceneId: 's1', nodeId: 1, frameIndex: 0, modelIndex: 0 },
    remove_scene_keyframe: { sceneId: 's1', nodeId: 0, frameIndex: 0 },
    animation_to_scene: { modelIds: ['m1'] },
  };
  for (const name of SCENE_ANIMATION_TOOL_NAMES) {
    const args = valid[name]!;
    const invalid: Record<string, unknown>[] = [{ ...args, unexpected: true }];
    if ('frameIndex' in args) invalid.push({ ...args, frameIndex: '0' });
    if (name === 'animation_to_scene') invalid.push(
      { ...args, loop: 'false' }, { ...args, modelIds: Array(513).fill('m1') },
      { ...args, durationsMs: Array(513).fill(100) }, { animationId: 'a1', loop: 'false' },
    );
    for (const input of invalid) {
      await assert.rejects(tools.get(name)!(input));
      assert.deepEqual(touches, [], `${name} accessed storage before rejecting ${Object.keys(input)}`);
    }
  }
});

test('native track counts reject before mapping and before editable access when peek is available', async () => {
  for (const type of ['nTRN', 'nSHP'] as const) {
    for (const withPeek of [true, false]) {
      const scene = fixture();
      const track = scene.nodes.find(n => n.type === type)!;
      const entries = Array(513);
      entries.map = () => { throw new Error('Oversized track was mapped'); };
      if (track.type === 'nTRN') track.frames = entries;
      else if (track.type === 'nSHP') track.models = entries;
      let gets = 0;
      const tools = new Map<string, (args: any) => Promise<CallToolResult>>();
      registerSceneAnimationTools((definition, handler) => { tools.set(definition.name, handler); }, {
        ...(withPeek ? { peek: () => scene } : {}),
        get() { gets++; return scene; },
        commit() { throw new Error('Unexpected commit'); },
      }, new ModelRegistry());
      const calls: [string, Record<string, unknown>][] = [
        ['inspect_scene_animation', { sceneId: 's1' }],
        ['set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 0, rotation: 4 }],
        ['set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 0, modelIndex: 0 }],
        ['remove_scene_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 0 }],
      ];
      for (const [name, args] of calls) await assert.rejects(tools.get(name)!(args), /1\.\.512 keyframes/);
      assert.equal(gets, withPeek ? 0 : calls.length);
    }
  }
});

test('transform keyframes insert and replace by explicit _f, preserve metadata and round-trip on disk', async () => {
  const h = harness();
  await h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 12, translation: [1, -2, 3], rotation: 4 });
  await h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 4, translation: [4, 0, 0] });
  await h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 0, rotation: 4 });
  await h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 12, translation: [9, 8, 7] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-animation-'));
  try {
    const file = path.join(dir, 'edited.vox'); saveVOXScene(file, h.scenes.get('s1')!);
    const decoded = decodeVOXScene(fs.readFileSync(file));
    const node = decoded.nodes[0]!; assert.equal(node.type, 'nTRN'); if (node.type !== 'nTRN') return;
    assert.deepEqual(node.frames.map(f => ({ ...f })), [{ _t: '0 0 0', custom: 'frame', _f: '0', _r: '4' }, { _f: '4', _t: '4 0 0' }, { _f: '12', _t: '9 8 7', _r: '4' }]);
    assert.equal(node.attributes.custom, 'keep');
    assert.deepEqual(decoded.document.main.children.find(c => c.id === 'TEST')!.content, Buffer.from([1, 2, 3]));
    assert.equal(decoded.nodes[1]!.attributes.custom, 'shape');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('model keyframes use bounded scene-model indices, sorted _f and preserve attributes', async () => {
  const h = harness();
  await h.call('set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 9, modelIndex: 1 });
  await h.call('set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 0, modelIndex: 1 });
  await h.call('set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 3, modelIndex: 0 });
  const node = decodeVOXScene(encodeVOXScene(h.scenes.get('s1')!)).nodes[1]!;
  assert.equal(node.type, 'nSHP'); if (node.type !== 'nSHP') return;
  assert.deepEqual(node.models.map(m => ({ modelId: m.modelId, attributes: { ...m.attributes } })), [
    { modelId: 1, attributes: { custom: 'model', _f: '0' } },
    { modelId: 0, attributes: { _f: '3' } }, { modelId: 1, attributes: { _f: '9' } },
  ]);
  const before = encodeVOXScene(h.scenes.get('s1')!);
  await assert.rejects(h.call('set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 4, modelIndex: 2 }), /model/i);
  assert.deepEqual(encodeVOXScene(h.scenes.get('s1')!), before);
  assert.equal(h.commits(), 3);
});

test('removal addresses explicit indices for both tracks and refuses to empty either track', async () => {
  const h = harness();
  await h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 8, translation: [8, 0, 0] });
  await h.call('set_scene_model_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 8, modelIndex: 1 });
  for (const nodeId of [0, 1]) {
    await assert.rejects(h.call('remove_scene_keyframe', { sceneId: 's1', nodeId, frameIndex: 1 }), /not found/i);
    await h.call('remove_scene_keyframe', { sceneId: 's1', nodeId, frameIndex: 0 });
    const before = encodeVOXScene(h.scenes.get('s1')!);
    await assert.rejects(h.call('remove_scene_keyframe', { sceneId: 's1', nodeId, frameIndex: 8 }), /at least one/i);
    assert.deepEqual(encodeVOXScene(h.scenes.get('s1')!), before);
  }
  const info = await h.call('inspect_scene_animation', { sceneId: 's1' });
  assert.deepEqual(info.tracks.map((t: any) => t.keyframes.map((f: any) => f.frameIndex)), [[8], [8]]);
  assert.equal(h.commits(), 4);
});

test('malformed, duplicate, excessive native tracks and invalid edits never commit', async () => {
  for (const frames of ([ [{ _f: '-1' }], [{ _f: 'NaN' }], [{ _f: '1.5' }], [{ _f: '' }], [{ _f: '1000001' }], [{ _f: '0' }, { _f: '0' }], [{ _f: '1' }, {}], Array.from({ length: 513 }, (_, i) => ({ _f: String(i) })) ] as VoxDictionary[][])) {
    const s = fixture(); const node = s.nodes[0]!; if (node.type !== 'nTRN') throw new Error(); node.frames = frames;
    const h = harness(s); const before = JSON.stringify(s);
    await assert.rejects(h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 5, translation: [0, 0, 0] }), /frame|track/i);
    assert.equal(h.commits(), 0); assert.equal(JSON.stringify(h.scenes.get('s1')), before);
  }
  const h = harness(); const before = encodeVOXScene(h.scenes.get('s1')!);
  for (const args of [ { frameIndex: -1 }, { frameIndex: 1.5 }, { frameIndex: 1000001 }, { rotation: 0 }, { rotation: 256 }, { translation: [1.5, 0, 0] }, { translation: [2147483648, 0, 0] }, { translation: [0, 0] }, { unexpected: true }, {} ]) {
    await assert.rejects(h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 0, frameIndex: 0, ...args }));
  }
  await assert.rejects(h.call('set_scene_transform_keyframe', { sceneId: 's1', nodeId: 1, frameIndex: 0, rotation: 4 }), /transform/i);
  assert.equal(h.commits(), 0); assert.deepEqual(encodeVOXScene(h.scenes.get('s1')!), before);
});

test('bridge rejects repeated models over scene storage budget before cloning voxel arrays', async () => {
  const voxels = Array(16_384);
  voxels.map = () => { throw new Error('Voxel clone attempted'); };
  const source = { ...model(), voxels };
  for (const sourceKind of ['models', 'animation'] as const) {
    const animations = new AnimationRegistry();
    animations.getData = () => ({ id: 'a1', name: 'Repeated', fps: 10, loop: true, frames: Array.from({ length: 65 }, () => ({ model: source, durationMs: 100 })) });
    const h = harness(fixture(), animations);
    h.registry.get = () => source;
    const args = sourceKind === 'models' ? { modelIds: Array(65).fill('m1'), fps: 10 } : { animationId: 'a1' };
    await assert.rejects(h.tools.get('animation_to_scene')!.handler(args), /(?:storage|allocation).*budget|budget.*storage/i);
    assert.equal(h.commits(), 0);
    assert.equal(h.scenes.size, 1);
  }
});

test('animation_to_scene bridges the supplied AnimationRegistry with native shape _f and copied models', async () => {
  const animations = new AnimationRegistry(); const id = animations.create('Walk'); animations.setFps(id, 10); animations.setLoop(id, false);
  animations.addFrame(id, model(), 100); animations.addFrame(id, { ...model(), voxels: [{ x: 1, y: 0, z: 0, i: 1 }] }, 250);
  const before = JSON.stringify(animations.getData(id));
  const h = harness(fixture(), animations);
  const result = await h.call('animation_to_scene', { animationId: id });
  assert.equal(result.source, 'animationRegistry'); assert.equal(result.sceneId, 's2');
  assert.deepEqual(result.timing.startFrames, [0, 1]); assert.equal(result.timing.totalFrames, 4);
  assert.equal(result.timing.totalDurationMs, 350); assert.equal(result.timing.fps, 10); assert.equal(result.timing.loop, false);
  assert.deepEqual(result.timing.quantizedDurationsMs, [100, 300]);
  assert.match(result.timing.note, /custom|not.*native/i);
  const s = decodeVOXScene(encodeVOXScene(h.scenes.get(result.sceneId)!));
  const shape = s.nodes.find(n => n.type === 'nSHP'); assert.equal(shape?.type, 'nSHP'); if (shape?.type !== 'nSHP') return;
  assert.deepEqual(shape.models.map(m => [m.modelId, m.attributes._f]), [[0, '0'], [1, '1']]);
  assert.equal(s.nodes[0]!.attributes._name, 'Walk'); assert.equal(s.nodes[0]!.attributes.animation_fps, '10');
  assert.equal(s.nodes[0]!.attributes.animation_duration_ms, '350');
  assert.equal(JSON.stringify(animations.getData(id)), before);
  h.scenes.get(result.sceneId)!.models[0]!.voxels[0]!.x = 1;
  assert.equal(animations.getData(id).frames[0]!.model.voxels[0]!.x, 0);
});

test('explicit modelIds provide a separate honest bridge with durations and uniform fps defaults', async () => {
  const h = harness();
  const a = h.registry.create(2, 2, 2).id; const b = h.registry.create(2, 2, 2).id;
  h.registry.set(a, model()); h.registry.set(b, model());
  const before = JSON.stringify(h.registry.get(a));
  const result = await h.call('animation_to_scene', { modelIds: [a, b], durationsMs: [100, 200], fps: 10, loop: false });
  assert.equal(result.source, 'modelRegistry'); assert.deepEqual(result.timing.startFrames, [0, 1]);
  assert.equal(result.timing.totalFrames, 3); assert.equal(result.timing.loop, false);
  const uniform = await h.call('animation_to_scene', { modelIds: [a, b], fps: 20 });
  assert.deepEqual(uniform.timing.startFrames, [0, 1]); assert.deepEqual(uniform.timing.durationsMs, [50, 50]);
  assert.equal(uniform.timing.loop, true);
  h.scenes.get(result.sceneId)!.models[0]!.voxels[0]!.x = 1;
  assert.equal(JSON.stringify(h.registry.get(a)), before);
  await assert.rejects(h.call('animation_to_scene', { animationId: '1' }), /not supplied/i);
});

test('bridge validates source selection, timing budgets and injected registry data before committing', async () => {
  const animations = new AnimationRegistry(); const id = animations.create(); animations.addFrame(id, model(), 100);
  const h = harness(fixture(), animations); const a = h.registry.create(2, 2, 2).id; h.registry.set(a, model());
  const original = JSON.stringify(animations.getData(id));
  const badInputs = [ {}, { animationId: id, modelIds: [a] }, { animationId: id, durationsMs: [100] }, { modelIds: [a, a], durationsMs: [100] }, { modelIds: [a], durationsMs: [100, 200] }, { modelIds: [a], durationsMs: [1], fps: 1 }, { modelIds: [a], durationsMs: [0] }, { modelIds: [a], fps: 0 }, { modelIds: [a], fps: 121 }, { modelIds: [a], fps: Infinity }, { modelIds: [a], durationsMs: [60001] }, { modelIds: Array(61).fill(a), durationsMs: Array(61).fill(60000) }, { modelIds: Array(513).fill(a) }, { modelIds: ['missing'] } ];
  for (const args of badInputs) await assert.rejects(h.call('animation_to_scene', args), JSON.stringify(args));
  const data = animations.getData(id);
  for (const patch of [ { fps: NaN }, { fps: 200 }, { frames: [] }, { frames: Array(513).fill(data.frames[0]) }, { frames: [{ model: model(), durationMs: -1 }] }, { frames: [{ model: model(), durationMs: 1 }] }, { frames: [{ model: model(), durationMs: Infinity }] }, { frames: [{ model: { ...model(), voxels: Array(8_000_001) }, durationMs: 100 }] } ]) {
    Object.assign(data, JSON.parse(original)); Object.assign(data, patch);
    await assert.rejects(h.call('animation_to_scene', { animationId: id }));
  }
  Object.assign(data, JSON.parse(original));
  assert.equal(h.commits(), 0); assert.equal(h.scenes.size, 1);
  assert.equal(JSON.stringify(animations.getData(id)), original);
});

test('inspection validates rotations in independently byte-authored native tracks', async () => {
  const bytes = voxFile([
    ...modelPair({ size: [2, 2, 2], voxels: [[0, 0, 0, 1]] }),
    chunk('nTRN', Buffer.concat([ints(0), dict({ _name: 'Native' }), ints(1, -1, -1, 2), dict({ _f: '0', _r: '4' }), dict({ _f: '12', _t: '1 2 3' })])),
    chunk('nSHP', Buffer.concat([ints(1), dict({}), ints(2, 0), dict({ _f: '0' }), ints(0), dict({ _f: '12', custom: 'hold' })])),
  ]);
  const h = harness(decodeVOXScene(bytes));
  const result = await h.call('inspect_scene_animation', { sceneId: 's1' });
  assert.deepEqual(result.tracks.map((t: any) => t.keyframes.map((f: any) => f.frameIndex)), [[0, 12], [0, 12]]);
  assert.deepEqual(encodeVOXScene(h.scenes.get('s1')!), bytes);
  const transform = h.scenes.get('s1')!.nodes[0]!; if (transform.type !== 'nTRN') throw new Error();
  transform.frames[0]!._r = '0';
  await assert.rejects(h.call('inspect_scene_animation', { sceneId: 's1' }), /rotation/i);
  assert.equal(h.commits(), 0);
});

test('inspection reports native transform and shape tracks without committing', async () => {
  const h = harness();
  const result = await h.call('inspect_scene_animation', { sceneId: 's1' });
  assert.deepEqual(result.tracks.map((t: any) => [t.nodeId, t.type, t.keyframes[0].frameIndex, t.keyframes[0].explicit]), [[0, 'nTRN', 0, false], [1, 'nSHP', 0, false]]);
  assert.equal(result.tracks[0].keyframes[0].attributes.custom, 'frame');
  assert.equal(result.tracks[1].keyframes[0].modelIndex, 0);
  assert.deepEqual([...h.tools.keys()], [...SCENE_ANIMATION_TOOL_NAMES]);
  assert.equal(h.commits(), 0);
});

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ModelRegistry } from './model.js';
import type { AnimationRegistry } from './animation.js';
import { createVOXScene, parseTranslation, validateScene } from './scene.js';
import type { VoxScene, SceneNode, VoxDictionary } from './scene.js';
import { isValidRotation } from './rotation.js';
import { preflightSceneModels, sceneStorageBytes } from './sceneEditing.js';

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
export interface SceneAnimationAccess {
  /** Return a borrowed read-only scene for preflight; never mutate this value. */
  peek?(sceneId: string): Readonly<VoxScene>;
  /** Return an editable snapshot; edits must not affect storage until commit succeeds. */
  get(sceneId: string): VoxScene;
  /** Validate storage budgets and atomically publish the snapshot. Omit sceneId to create a scene. */
  commit(scene: VoxScene, sceneId?: string): string;
}

export const SCENE_ANIMATION_TOOL_NAMES = [
  'inspect_scene_animation',
  'set_scene_animation_range',
  'set_scene_transform_keyframe',
  'set_scene_model_keyframe',
  'remove_scene_keyframe',
  'animation_to_scene',
] as const;

const frameIndexSchema = z.number().int().min(0).max(1_000_000)
  .describe('Explicit native _f index, 0..1000000; each track supports at most 512 keyframes');
const targetSchema = { sceneId: z.string(), nodeId: z.number().int().min(0).max(2147483647), frameIndex: frameIndexSchema };
export const inspectSceneAnimationSchema = z.object({ sceneId: z.string() }).strict();
const nativeRangeFrameSchema = z.number().int().min(0).max(360);
export const setSceneAnimationRangeSchema = z.object({ sceneId: z.string(), start: nativeRangeFrameSchema, end: nativeRangeFrameSchema }).strict()
  .refine(({ start, end }) => end >= start, 'Native animation range end must be >= start');
export interface SceneAnimationRange { start: number; end: number }
export const setSceneTransformKeyframeSchema = z.object({ ...targetSchema, translation: z.tuple([z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647)]).optional(), rotation: z.number().int().refine(isValidRotation, 'Invalid packed rotation').optional() }).strict();
export const setSceneModelKeyframeSchema = z.object({ ...targetSchema, modelIndex: z.number().int().min(0) }).strict();
export const removeSceneKeyframeSchema = z.object(targetSchema).strict();
export const animationToSceneSchema = z.object({ animationId: z.string().optional(), modelIds: z.array(z.string()).min(1).max(512).optional(), fps: z.number().min(1).max(120).optional(), durationsMs: z.array(z.number().positive().max(60_000)).min(1).max(512).optional(), loop: z.boolean().optional(), nativeTiming: z.boolean().default(true) }).strict();
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function nativeAnimationRange(scene: Readonly<VoxScene>): SceneAnimationRange | undefined {
  const raw = scene.render.meta?._anim_range;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+ \d+$/.test(raw)) throw new Error('Invalid native animation range (_anim_range)');
  const [start, end] = raw.split(' ').map(Number) as [number, number];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 360 || end < start) throw new Error('Invalid native animation range (_anim_range): expected 0 <= start <= end <= 360');
  return { start, end };
}
type Track = Extract<SceneNode, { type: 'nTRN' | 'nSHP' }>;
function checkTrackCount(node: Track): void {
  const count = node.type === 'nTRN' ? node.frames.length : node.models.length;
  if (count < 1 || count > 512) throw new Error('Track requires 1..512 keyframes');
}
function checkSceneTrackCounts(scene: Readonly<VoxScene>): void {
  nativeAnimationRange(scene);
  for (const node of scene.nodes) if (node.type !== 'nGRP') checkTrackCount(node);
}
function editableAnimationScene(access: SceneAnimationAccess, sceneId: string): VoxScene {
  if (access.peek) checkSceneTrackCounts(access.peek(sceneId));
  const scene = access.get(sceneId);
  checkSceneTrackCounts(scene);
  return scene;
}
function keyframes(node: Track): { attributes: VoxDictionary; modelIndex?: number; frameIndex: number; explicit: boolean }[] {
  checkTrackCount(node);
  const entries = node.type === 'nTRN' ? node.frames.map(attributes => ({ attributes })) : node.models.map(m => ({ attributes: m.attributes, modelIndex: m.modelId }));
  const seen = new Set<number>();
  return entries.map((entry, index) => {
    const raw = entry.attributes._f;
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error('Invalid native frame index');
    const frameIndex = raw === undefined ? index : Number(raw);
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 1_000_000 || seen.has(frameIndex)) throw new Error('Invalid or duplicate native frame index');
    seen.add(frameIndex);
    return { ...entry, frameIndex, explicit: raw !== undefined };
  });
}
function validateAnimationScene(scene: VoxScene): void {
  nativeAnimationRange(scene);
  for (const node of scene.nodes) if (node.type !== 'nGRP') keyframes(node);
  validateScene(scene);
}
export function registerSceneAnimationTools(register: RegisterTool, access: SceneAnimationAccess, registry: ModelRegistry, animations?: AnimationRegistry): void {
  register({ name: 'inspect_scene_animation', description: 'Inspect the native META _anim_range playback range and nTRN/nSHP _f tracks. Missing range is undefined; malformed ranges are rejected. Missing _f uses its entry position as a fallback; no playback speed or interpolation is inferred.', inputSchema: inspectSceneAnimationSchema }, async (args) => {
    const { sceneId } = inspectSceneAnimationSchema.parse(args);
    const scene = editableAnimationScene(access, sceneId);
    validateAnimationScene(scene);
    return text({ sceneId, range: nativeAnimationRange(scene), tracks: scene.nodes.filter((n): n is Track => n.type === 'nTRN' || n.type === 'nSHP').map(n => ({ nodeId: n.id, type: n.type, attributes: n.attributes, keyframes: keyframes(n) })) });
  });
  register({ name: 'set_scene_animation_range', description: 'Set the inclusive native META _anim_range playback range, 0..360. Preserves other metadata; does not set application playback speed.', inputSchema: setSceneAnimationRangeSchema }, async (args) => {
    const { sceneId, start, end } = setSceneAnimationRangeSchema.parse(args);
    const scene = editableAnimationScene(access, sceneId);
    // Mutate the editable dictionary rather than replacing it, retaining decoded META provenance.
    scene.render.meta ??= {};
    scene.render.meta._anim_range = `${start} ${end}`;
    validateAnimationScene(scene);
    const range: SceneAnimationRange = { start, end };
    return text({ sceneId: access.commit(scene, sceneId), range });
  });
  register({ name: 'set_scene_transform_keyframe', description: 'Insert or update a transform at explicit native _f frame index (not array position), preserving unrelated attributes.', inputSchema: setSceneTransformKeyframeSchema }, async (args) => {
    const { sceneId, nodeId, frameIndex, translation, rotation } = setSceneTransformKeyframeSchema.parse(args);
    if (translation === undefined && rotation === undefined) throw new Error('Provide translation or rotation');
    const scene = editableAnimationScene(access, sceneId);
    const node = scene.nodes.find(n => n.id === nodeId);
    if (node?.type !== 'nTRN') throw new Error('Node is not a transform');
    const frames = keyframes(node).map(f => ({ frameIndex: f.frameIndex, attributes: { ...f.attributes, _f: String(f.frameIndex) } as VoxDictionary }));
    const existing = frames.find(f => f.frameIndex === frameIndex);
    const attributes: VoxDictionary = { ...(existing?.attributes ?? {}), _f: String(frameIndex) };
    if (translation) { parseTranslation(translation.join(' ')); attributes._t = translation.join(' '); }
    if (rotation !== undefined) attributes._r = String(rotation);
    if (existing) existing.attributes = attributes; else frames.push({ frameIndex, attributes });
    node.frames = frames.sort((a, b) => a.frameIndex - b.frameIndex).map(f => f.attributes);
    validateAnimationScene(scene);
    return text({ sceneId: access.commit(scene, sceneId), nodeId, frameIndex });
  });
  register({ name: 'set_scene_model_keyframe', description: 'Insert or update an nSHP model reference at explicit _f frame index. modelIndex addresses scene models, not the model registry.', inputSchema: setSceneModelKeyframeSchema }, async (args) => {
    const { sceneId, nodeId, frameIndex, modelIndex } = setSceneModelKeyframeSchema.parse(args);
    const scene = editableAnimationScene(access, sceneId);
    const node = scene.nodes.find(n => n.id === nodeId);
    if (node?.type !== 'nSHP') throw new Error('Node is not a shape');
    if (!scene.models[modelIndex]) throw new Error('Scene model index out of range');
    const frames = keyframes(node).map(f => ({ frameIndex: f.frameIndex, modelId: f.modelIndex ?? 0, attributes: { ...f.attributes, _f: String(f.frameIndex) } as VoxDictionary }));
    const existing = frames.find(f => f.frameIndex === frameIndex);
    if (existing) existing.modelId = modelIndex;
    else frames.push({ frameIndex, modelId: modelIndex, attributes: { _f: String(frameIndex) } });
    node.models = frames.sort((a, b) => a.frameIndex - b.frameIndex).map(f => ({ modelId: f.modelId, attributes: f.attributes }));
    validateAnimationScene(scene);
    return text({ sceneId: access.commit(scene, sceneId), nodeId, frameIndex, modelIndex });
  });
  register({ name: 'remove_scene_keyframe', description: 'Remove a transform or model keyframe by explicit _f index, keeping at least one entry in the track.', inputSchema: removeSceneKeyframeSchema }, async (args) => {
    const { sceneId, nodeId, frameIndex } = removeSceneKeyframeSchema.parse(args);
    const scene = editableAnimationScene(access, sceneId);
    const node = scene.nodes.find(n => n.id === nodeId);
    if (!node || node.type === 'nGRP') throw new Error('Node is not an animation track');
    const frames = keyframes(node);
    if (!frames.some(f => f.frameIndex === frameIndex)) throw new Error('Keyframe not found');
    if (frames.length === 1) throw new Error('Track requires at least one keyframe');
    const remaining = frames.filter(f => f.frameIndex !== frameIndex).sort((a, b) => a.frameIndex - b.frameIndex);
    if (node.type === 'nTRN') node.frames = remaining.map(f => ({ ...f.attributes, _f: String(f.frameIndex) }));
    else node.models = remaining.map(f => ({ modelId: f.modelIndex!, attributes: { ...f.attributes, _f: String(f.frameIndex) } }));
    validateAnimationScene(scene);
    return text({ sceneId: access.commit(scene, sceneId), nodeId, frameIndex });
  });
  register({ name: 'animation_to_scene', description: 'Copy AnimationRegistry animationId or explicit ModelRegistry modelIds into the native world/group/object/shape hierarchy with _loop. nativeTiming defaults true: compile distinct copied models and sequential _f keys for every quantized tick, including the last hold (1..361 ticks), and set META _anim_range. False retains sparse source-start keys with no native duration guarantee. FPS/durations are descriptive custom metadata; set wall-clock playback speed in the application, not VOX.', inputSchema: animationToSceneSchema }, async (args) => {
    const { animationId, modelIds, fps: requestedFps, durationsMs, loop, nativeTiming } = animationToSceneSchema.parse(args);
    if ((animationId !== undefined) === (modelIds !== undefined)) throw new Error('Provide exactly one of animationId or modelIds');
    if (animationId !== undefined && durationsMs !== undefined) throw new Error('durationsMs is only supported with modelIds');
    if (durationsMs !== undefined && durationsMs.length !== modelIds?.length) throw new Error('durationsMs must match the modelIds count');
    if (animationId !== undefined && !animations) throw new Error('AnimationRegistry was not supplied');
    const animation = animationId !== undefined ? animations!.getData(animationId) : undefined;
    const fps = z.number().min(1).max(120).parse(requestedFps ?? animation?.fps ?? 12);
    const frameCount = animation ? animation.frames.length : modelIds!.length;
    if (frameCount < 1 || frameCount > 512) throw new Error('Animation requires 1..512 frames');
    const sourceDuration = (index: number): number => animation ? animation.frames[index]!.durationMs : durationsMs?.[index] ?? 1000 / fps;
    const sourceModel = (index: number): VoxScene['models'][number] => animation ? animation.frames[index]!.model : registry.get(modelIds![index]!);
    const looping = loop ?? animation?.loop ?? true;
    let durationMs = 0;
    // Scalar preflight first: no source/timeline arrays or voxel elements are copied.
    for (let i = 0; i < frameCount; i++) {
      const duration = z.number().positive().max(60_000).parse(sourceDuration(i));
      const start = Math.round(durationMs * fps / 1000);
      durationMs += duration;
      if (Math.round(durationMs * fps / 1000) <= start) throw new Error('Frame duration is shorter than one timeline tick at this fps');
    }
    if (durationMs > 3_600_000) throw new Error('Animation duration limit exceeded (3600000 ms)');
    const totalFrames = Math.round(durationMs * fps / 1000);
    if (nativeTiming && (totalFrames < 1 || totalFrames > 361)) throw new Error('Native compiled animation requires 1..361 timeline ticks (range 0..360)');
    let elapsedMs = 0, voxelCount = 0;
    for (let i = 0; i < frameCount; i++) {
      const start = Math.round(elapsedMs * fps / 1000);
      elapsedMs += sourceDuration(i);
      const copies = nativeTiming ? Math.round(elapsedMs * fps / 1000) - start : 1;
      voxelCount += copies * sourceModel(i).voxels.length;
      if (!Number.isSafeInteger(voxelCount) || voxelCount > 8_000_000) throw new Error('Animation replicated voxel budget exceeded (8000000)');
    }
    const models: VoxScene['models'] = [];
    elapsedMs = 0;
    for (let i = 0; i < frameCount; i++) {
      const start = Math.round(elapsedMs * fps / 1000);
      elapsedMs += sourceDuration(i);
      const copies = nativeTiming ? Math.round(elapsedMs * fps / 1000) - start : 1;
      const model = sourceModel(i);
      // Repeated references are charged separately by preflight, never deduplicated.
      for (let tick = 0; tick < copies; tick++) models.push(model);
    }
    preflightSceneModels(models);
    const startFrames: number[] = [], sourceDurationsMs: number[] = [];
    elapsedMs = 0;
    for (let i = 0; i < frameCount; i++) {
      startFrames.push(Math.round(elapsedMs * fps / 1000));
      const duration = sourceDuration(i);
      sourceDurationsMs.push(duration);
      elapsedMs += duration;
    }
    // Project the graph with borrowed models; check retained storage before copying geometry.
    const scene: VoxScene = { document: { version: 150, main: { id: 'MAIN', content: Buffer.alloc(0), children: [] } }, models, nodes: [], layers: [], materials: [], render: { objects: [], cameras: [] } };
    if (totalFrames <= 361) scene.render.meta = { _anim_range: `0 ${totalFrames - 1}` };
    scene.layers = [{ id: 0, attributes: { _name: 'Objects' } }];
    scene.nodes = [
      { type: 'nTRN', id: 0, attributes: { _name: animation?.name ?? 'Animation', animation_fps: String(fps), animation_duration_ms: String(durationMs), animation_loop: String(looping), animation_durations_ms: JSON.stringify(sourceDurationsMs), animation_total_frames: String(totalFrames) }, childId: 1, layerId: -1, frames: [{ _f: '0', _t: '0 0 0' }] },
      { type: 'nGRP', id: 1, attributes: {}, children: [2] },
      { type: 'nTRN', id: 2, attributes: {}, childId: 3, layerId: 0, frames: [{ _t: '0 0 0' }] },
      { type: 'nSHP', id: 3, attributes: { _loop: looping ? '1' : '0' }, models: models.map((_, modelId) => ({ modelId, attributes: { _f: String(nativeTiming ? modelId : startFrames[modelId]) } })) },
    ];
    validateAnimationScene(scene);
    sceneStorageBytes(scene);
    scene.models = createVOXScene(models).models;
    return text({ sceneId: access.commit(scene), source: animationId !== undefined ? 'animationRegistry' : 'modelRegistry', modelCount: scene.models.length, keyframeCount: models.length, timing: { mode: nativeTiming ? 'compiled' : 'sparse', fps, loop: looping, totalDurationMs: durationMs, totalFrames, startFrames, durationsMs: sourceDurationsMs, quantizedDurationsMs: startFrames.map((start, i) => ((startFrames[i + 1] ?? totalFrames) - start) * 1000 / fps), note: `${nativeTiming ? 'Distinct native models and sequential keys hold every quantized tick, including the last.' : 'Sparse source-start keys: no native duration guarantee.'} FPS and durations are descriptive custom metadata; FPS/wall-clock playback speed is set in the application, not in VOX.` } });
  });
}

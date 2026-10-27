import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ModelRegistry } from './model.js';
import type { AnimationRegistry } from './animation.js';
import { createVOXScene, parseTranslation, validateScene } from './scene.js';
import type { VoxScene, SceneNode, VoxDictionary } from './scene.js';
import { isValidRotation } from './rotation.js';
import { preflightSceneModels } from './sceneEditing.js';

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
  'set_scene_transform_keyframe',
  'set_scene_model_keyframe',
  'remove_scene_keyframe',
  'animation_to_scene',
] as const;

const frameIndexSchema = z.number().int().min(0).max(1_000_000)
  .describe('Explicit native _f index, 0..1000000; each track supports at most 512 keyframes');
const targetSchema = { sceneId: z.string(), nodeId: z.number().int().min(0).max(2147483647), frameIndex: frameIndexSchema };
export const inspectSceneAnimationSchema = z.object({ sceneId: z.string() }).strict();
export const setSceneTransformKeyframeSchema = z.object({ ...targetSchema, translation: z.tuple([z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647)]).optional(), rotation: z.number().int().refine(isValidRotation, 'Invalid packed rotation').optional() }).strict();
export const setSceneModelKeyframeSchema = z.object({ ...targetSchema, modelIndex: z.number().int().min(0) }).strict();
export const removeSceneKeyframeSchema = z.object(targetSchema).strict();
export const animationToSceneSchema = z.object({ animationId: z.string().optional(), modelIds: z.array(z.string()).min(1).max(512).optional(), fps: z.number().min(1).max(120).optional(), durationsMs: z.array(z.number().positive().max(60_000)).min(1).max(512).optional(), loop: z.boolean().optional() }).strict();
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
type Track = Extract<SceneNode, { type: 'nTRN' | 'nSHP' }>;
function checkTrackCount(node: Track): void {
  const count = node.type === 'nTRN' ? node.frames.length : node.models.length;
  if (count < 1 || count > 512) throw new Error('Track requires 1..512 keyframes');
}
function checkSceneTrackCounts(scene: Readonly<VoxScene>): void {
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
  for (const node of scene.nodes) if (node.type !== 'nGRP') keyframes(node);
  validateScene(scene);
}
export function registerSceneAnimationTools(register: RegisterTool, access: SceneAnimationAccess, registry: ModelRegistry, animations?: AnimationRegistry): void {
  register({ name: 'inspect_scene_animation', description: 'Inspect native nTRN/nSHP _f tracks. Missing _f uses its entry position as a fallback; no playback or interpolation is inferred.', inputSchema: inspectSceneAnimationSchema }, async (args) => {
    const { sceneId } = inspectSceneAnimationSchema.parse(args);
    const scene = editableAnimationScene(access, sceneId);
    validateAnimationScene(scene);
    return text({ sceneId, tracks: scene.nodes.filter((n): n is Track => n.type === 'nTRN' || n.type === 'nSHP').map(n => ({ nodeId: n.id, type: n.type, attributes: n.attributes, keyframes: keyframes(n) })) });
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
  register({ name: 'animation_to_scene', description: 'Copy animationId from the supplied AnimationRegistry, or explicit modelIds from ModelRegistry, to native shape _f keyframes. Uses the native world-group/object hierarchy and shape _loop flag. Timing is quantized to fps; fps and durations remain custom metadata, not native playback guarantees.', inputSchema: animationToSceneSchema }, async (args) => {
    const { animationId, modelIds, fps: requestedFps, durationsMs, loop } = animationToSceneSchema.parse(args);
    if ((animationId !== undefined) === (modelIds !== undefined)) throw new Error('Provide exactly one of animationId or modelIds');
    if (animationId !== undefined && durationsMs !== undefined) throw new Error('durationsMs is only supported with modelIds');
    if (durationsMs !== undefined && durationsMs.length !== modelIds?.length) throw new Error('durationsMs must match the modelIds count');
    if (animationId !== undefined && !animations) throw new Error('AnimationRegistry was not supplied');
    const animation = animationId !== undefined ? animations!.getData(animationId) : {
      name: 'Animation', fps: requestedFps ?? 12, loop: loop ?? true,
      frames: (modelIds ?? []).map((id, i) => ({ model: registry.get(id), durationMs: durationsMs?.[i] ?? 1000 / (requestedFps ?? 12) })),
    };
    const fps = z.number().min(1).max(120).parse(requestedFps ?? animation.fps);
    if (animation.frames.length < 1 || animation.frames.length > 512) throw new Error('Animation requires 1..512 frames');
    if (animation.frames.reduce((count, f) => count + f.model.voxels.length, 0) > 8_000_000) throw new Error('Animation voxel budget exceeded (8000000)');
    const looping = loop ?? animation.loop;
    let durationMs = 0;
    const startFrames = animation.frames.map(frame => {
      z.number().positive().max(60_000).parse(frame.durationMs);
      const start = Math.round(durationMs * fps / 1000);
      durationMs += frame.durationMs;
      return start;
    });
    if (durationMs > 3_600_000) throw new Error('Animation duration limit exceeded (3600000 ms)');
    const totalFrames = Math.round(durationMs * fps / 1000);
    if (startFrames.some((start, i) => (startFrames[i + 1] ?? totalFrames) <= start)) throw new Error('Frame duration is shorter than one timeline tick at this fps');
    const models = animation.frames.map(f => f.model);
    preflightSceneModels(models);
    const scene = createVOXScene(models);
    scene.layers = [{ id: 0, attributes: { _name: 'Objects' } }];
    scene.nodes = [
      { type: 'nTRN', id: 0, attributes: { _name: animation.name, animation_fps: String(fps), animation_duration_ms: String(durationMs), animation_loop: String(looping), animation_durations_ms: JSON.stringify(animation.frames.map(f => f.durationMs)), animation_total_frames: String(totalFrames) }, childId: 1, layerId: -1, frames: [{ _f: '0', _t: '0 0 0' }] },
      { type: 'nGRP', id: 1, attributes: {}, children: [2] },
      { type: 'nTRN', id: 2, attributes: {}, childId: 3, layerId: 0, frames: [{ _t: '0 0 0' }] },
      { type: 'nSHP', id: 3, attributes: { _loop: looping ? '1' : '0' }, models: startFrames.map((frameIndex, modelId) => ({ modelId, attributes: { _f: String(frameIndex) } })) },
    ];
    validateAnimationScene(scene);
    return text({ sceneId: access.commit(scene), source: animationId !== undefined ? 'animationRegistry' : 'modelRegistry', timing: { fps, loop: looping, totalDurationMs: durationMs, totalFrames, startFrames, durationsMs: animation.frames.map(f => f.durationMs), quantizedDurationsMs: startFrames.map((start, i) => ((startFrames[i + 1] ?? totalFrames) - start) * 1000 / fps), note: 'fps and durations are custom metadata; native _f and _loop do not guarantee wall-clock playback timing.' } });
  });
}

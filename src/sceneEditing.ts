import { cloneModel } from './model.js';
import type { VoxModelData } from './vox.js';
import { defaultPalette } from './vox.js';
import { indexScene, paletteMismatch, scenePalette } from './scene.js';
import type { VoxScene, SceneNode } from './scene.js';
import { remapModelToPalette } from './paletteRemap.js';

export interface SceneStorageOptions {
  historyLimit?: number;
  maxHistoryBytes?: number;
  maxStorageBytes?: number;
  maxScenes?: number;
}
export const SCENE_STORAGE_BYTES = 64 * 1024 * 1024;
export const SCENE_INPUT_BYTES = 16 * 1024 * 1024;
// Transient decoder/copy work is separately bounded from retained scene history.
export const SCENE_TRANSIENT_BYTES = 256 * 1024 * 1024;
export const SCENE_RESOURCE_LIMITS = Object.freeze({
  models: 4096, nodes: 16_384, edges: 400_000, frames: 65_536,
  tracks: 65_536, dictionaries: 131_072, properties: 262_144,
  dictionaryProperties: 256, chunks: 32_768, arrayItems: 400_000,
});

/** Bound peak model-copy/remap/VOX encode+decode work before touching voxel elements.
 * Repeated model references are deliberately counted repeatedly. Increasing retained storage
 * does not increase this independent transient limit; callers may only tighten it. */
export function preflightSceneModels(models: readonly VoxModelData[], budget = SCENE_TRANSIENT_BYTES): void {
  checkCount(budget, Number.MAX_SAFE_INTEGER, 'transient budget');
  const limit = Math.min(budget, SCENE_TRANSIENT_BYTES);
  checkCount(models.length, SCENE_RESOURCE_LIMITS.models, 'model count');
  let bytes = 1024, occupancy = 0;
  for (const model of models) {
    checkCount(model.voxels.length, 4_000_000, 'voxel count');
    if (![model.sizeX, model.sizeY, model.sizeZ].every(n => Number.isInteger(n) && n >= 1 && n <= 256)) throw new Error('Model dimensions must be integers 1..256');
    if (model.palette && model.palette.length !== 256) throw new Error('Palette must have 256 entries');
    // Original + cloned/remapped voxels, decode maps/objects and serialized buffers.
    bytes += 4096 + model.voxels.length * 320;
    if (model.voxels.length) occupancy = Math.max(occupancy, model.sizeX * model.sizeY * model.sizeZ * 2);
    if (!Number.isSafeInteger(bytes) || bytes + occupancy > limit) throw new Error(`Scene transient allocation budget exceeded (${limit} bytes)`);
  }
  if (bytes + occupancy > limit) throw new Error(`Scene transient allocation budget exceeded (${limit} bytes)`);
}

/** Scan counts and projected decoder allocations directly from the bounded input buffer.
 * This deliberately does not decode strings, create dictionaries, copy chunks or materialize voxels.
 * The normal decoder remains responsible for semantic/UTF-8 validation and lenient recovery. */
export function preflightSceneFile(input: Buffer, lenient = false): void {
  let bytes = input.length * 4 + 1024, chunks = 0, nodes = 0, edges = 0, frames = 0, tracks = 0;
  let dictionaries = 0, properties = 0, models = 0, occupancy = 0;
  const charge = (n: number) => {
    bytes += n;
    if (!Number.isSafeInteger(bytes) || bytes + occupancy > SCENE_TRANSIENT_BYTES) throw new Error('Scene input allocation budget exceeded');
  };
  const scan = (offset: number, end: number, depth: number): number => {
    checkCount(depth, 128, 'chunk depth'); checkCount(++chunks, SCENE_RESOURCE_LIMITS.chunks, 'chunk count'); charge(192);
    if (offset + 12 > end) throw new Error('Truncated scene chunk');
    const id = input.toString('latin1', offset, offset + 4), start = offset + 12;
    const contentEnd = start + input.readUInt32LE(offset + 4), chunkEnd = contentEnd + input.readUInt32LE(offset + 8);
    if (chunkEnd > end) throw new Error('Truncated scene chunk');
    let pos = start;
    const int = (): number => {
      if (pos + 4 > contentEnd) throw new Error('Truncated scene metadata');
      const n = input.readInt32LE(pos); pos += 4; return n;
    };
    const count = (limit: number, kind: string): number => {
      const n = int(); if (n < 0) throw new Error('Invalid scene metadata count');
      checkCount(n, limit, kind); return n;
    };
    const string = () => {
      const length = int();
      if (length < 0 || length > contentEnd - pos) throw new Error('Truncated scene string');
      charge(32 + length * 16); pos += length;
    };
    const dict = () => {
      checkCount(++dictionaries, SCENE_RESOURCE_LIMITS.dictionaries, 'dictionary count'); charge(160);
      const n = count(SCENE_RESOURCE_LIMITS.dictionaryProperties, 'dictionary property count');
      properties += n; checkCount(properties, SCENE_RESOURCE_LIMITS.properties, 'property count'); charge(n * 64);
      for (let i = 0; i < n; i++) { string(); string(); }
    };
    if (depth === 1) {
      if (id === 'SIZE' && contentEnd - start >= 12) {
        const x = int(), y = int(), z = int();
        if ([x, y, z].every(n => n >= 1 && n <= 256)) occupancy = Math.max(occupancy, x * y * z * 2);
        charge(0);
      } else if (id === 'XYZI') {
        checkCount(++models, SCENE_RESOURCE_LIMITS.models, 'model count');
        charge(4096 + count(4_000_000, 'voxel count') * 320);
      } else if (id === 'nTRN' || id === 'nGRP' || id === 'nSHP' || id === 'LAYR' || id === 'MATL') {
        checkCount(++nodes, SCENE_RESOURCE_LIMITS.nodes, 'node/metadata count'); charge(192); int(); dict();
        if (id === 'nTRN') {
          int(); int(); int(); const n = count(SCENE_RESOURCE_LIMITS.frames, 'frame count');
          checkCount(++edges, SCENE_RESOURCE_LIMITS.edges, 'edge count');
          frames += n; checkCount(frames, SCENE_RESOURCE_LIMITS.frames, 'frame count'); charge(n * 16);
          for (let i = 0; i < n; i++) dict();
        } else if (id === 'nGRP') {
          const n = count(SCENE_RESOURCE_LIMITS.edges, 'edge count');
          edges += n; checkCount(edges, SCENE_RESOURCE_LIMITS.edges, 'edge count'); charge(n * 16);
          if (n * 4 > contentEnd - pos) throw new Error('Truncated scene edges');
        } else if (id === 'nSHP') {
          const n = count(SCENE_RESOURCE_LIMITS.tracks, 'track count');
          tracks += n; checkCount(tracks, SCENE_RESOURCE_LIMITS.tracks, 'track count'); charge(n * 112);
          for (let i = 0; i < n; i++) { int(); dict(); }
        }
      } else if (id === 'rOBJ' || id === 'rCAM' || id === 'META' || id === 'NOTE') {
        try {
          if (id === 'rCAM') int();
          if (id === 'NOTE') {
            const n = count(SCENE_RESOURCE_LIMITS.arrayItems, 'note count'); charge(n * 16);
            for (let i = 0; i < n; i++) string();
          } else dict();
        } catch (error) {
          // Malformed optional render metadata may be skipped, but never resource-limit failures.
          if (!lenient || !(error instanceof Error) || /resource|budget|storage/.test(error.message)) throw error;
        }
      }
    }
    let child = contentEnd;
    while (child < chunkEnd) child = scan(child, chunkEnd, depth + 1);
    return chunkEnd;
  };
  charge(0);
  if (input.length < 20 || input.toString('ascii', 0, 4) !== 'VOX ') throw new Error('Not a complete VOX file');
  if (scan(8, input.length, 0) !== input.length) throw new Error('Trailing scene bytes');
}

function checkCount(count: number, limit: number, kind: string): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) throw new Error(`Scene ${kind} resource limit exceeded (${limit})`);
}
/** Incremental conservative retained-storage units, including serialized-cache/original metadata allowance.
 * No JSON strings or voxel copies are made. Aliases are charged per occurrence, as snapshots may copy them.
 * Hard cardinality limits apply even when the caller supplies a larger byte budget. */
export function sceneStorageBytes(scene: VoxScene, budget = SCENE_STORAGE_BYTES, additionalNodes: readonly SceneNode[] = []): number {
  checkCount(budget, Number.MAX_SAFE_INTEGER, 'storage budget');
  let bytes = 0, edges = 0, frames = 0, tracks = 0, dictionaries = 0, properties = 0, chunks = 0;
  const charge = (n: number) => {
    bytes += n;
    if (!Number.isSafeInteger(bytes) || bytes > budget) throw new Error(`Scene storage limit exceeded (${budget} bytes)`);
  };
  const array = (length: number, limit: number = SCENE_RESOURCE_LIMITS.arrayItems) => {
    checkCount(length, limit, 'array count'); charge(48 + length * 16);
  };
  const string = (value: string) => {
    if (typeof value !== 'string') throw new Error('Scene metadata must be strings');
    // UTF-16 storage, worst-case escaped JSON cache, native UTF-8 and serialization scratch.
    charge(32 + value.length * 16);
  };
  const dict = (value: Record<string, string>) => {
    checkCount(++dictionaries, SCENE_RESOURCE_LIMITS.dictionaries, 'dictionary count'); charge(96);
    let count = 0;
    for (const key in value) if (Object.hasOwn(value, key)) {
      checkCount(++count, SCENE_RESOURCE_LIMITS.dictionaryProperties, 'dictionary property count');
      checkCount(++properties, SCENE_RESOURCE_LIMITS.properties, 'property count');
      charge(64); string(key); string(value[key]!);
    }
  };
  const chunk = (value: VoxScene['document']['main'], depth: number): void => {
    checkCount(depth, 128, 'chunk depth');
    checkCount(++chunks, SCENE_RESOURCE_LIMITS.chunks, 'chunk count');
    charge(128 + value.content.length * 4); string(value.id); array(value.children.length, SCENE_RESOURCE_LIMITS.chunks);
    for (const child of value.children) chunk(child, depth + 1);
  };
  charge(256); chunk(scene.document.main, 0);
  array(scene.models.length, SCENE_RESOURCE_LIMITS.models);
  for (const model of scene.models) {
    array(model.voxels.length, 4_000_000);
    charge(192 + model.voxels.length * 80 + (model.palette ? 128 + model.palette.byteLength * 2 : 0) + 2048);
  }
  array(scene.nodes.length + additionalNodes.length, SCENE_RESOURCE_LIMITS.nodes);
  for (const node of (function* () { yield* scene.nodes; yield* additionalNodes; })()) {
    charge(192); dict(node.attributes);
    if (node.type === 'nTRN') {
      checkCount(++edges, SCENE_RESOURCE_LIMITS.edges, 'edge count');
      frames += node.frames.length; checkCount(frames, SCENE_RESOURCE_LIMITS.frames, 'frame count');
      array(node.frames.length, SCENE_RESOURCE_LIMITS.frames);
      for (const frame of node.frames) { charge(32); dict(frame); }
    } else if (node.type === 'nGRP') {
      edges += node.children.length; checkCount(edges, SCENE_RESOURCE_LIMITS.edges, 'edge count'); array(node.children.length);
    } else {
      tracks += node.models.length; checkCount(tracks, SCENE_RESOURCE_LIMITS.tracks, 'track count');
      array(node.models.length, SCENE_RESOURCE_LIMITS.tracks);
      for (const track of node.models) { charge(96); dict(track.attributes); }
    }
  }
  for (const values of [scene.layers, scene.materials, scene.render.objects, scene.render.cameras]) {
    array(values.length, SCENE_RESOURCE_LIMITS.nodes);
    for (const value of values) { charge(128); dict(value.attributes); if ('type' in value) string(value.type); }
  }
  if (scene.render.meta) dict(scene.render.meta);
  for (const values of [scene.render.notes, scene.warnings]) if (values) { array(values.length); for (const value of values) string(value); }
  if (scene.render.imap) array(scene.render.imap.length, 256);
  return bytes;
}
export function trimSceneHistory(past: VoxScene[], future: VoxScene[], limit: number, maxBytes: number): void {
  let bytes = [...past, ...future].reduce((sum, scene) => sum + sceneStorageBytes(scene), 0);
  while (past.length + future.length > limit || bytes > maxBytes) {
    // Entries at index zero are farthest from the current state.
    const removed = past.length ? past.shift() : future.shift();
    if (!removed) break;
    bytes -= sceneStorageBytes(removed);
  }
}
const MAX_ID = 2147483647;
const childrenOf = (node: SceneNode): number[] => node.type === 'nTRN' ? [node.childId] : node.type === 'nGRP' ? node.children : [];
function subtree(scene: VoxScene, nodeId: number): Set<number> {
  const nodes = indexScene(scene).nodes;
  if (!nodes.has(nodeId)) throw new Error('Scene node not found');
  const result = new Set<number>(), stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id); for (const child of childrenOf(nodes.get(id)!)) if (!result.has(child)) stack.push(child);
  }
  return result;
}
export function preflightSceneDuplicate(scene: VoxScene, nodeId: number, parentId?: number, budget = SCENE_TRANSIENT_BYTES): number[] {
  sceneStorageBytes(scene, Math.min(budget, SCENE_TRANSIENT_BYTES));
  groupFor(scene, parentId);
  const ids = [...subtree(scene, nodeId)], nodes = indexScene(scene).nodes;
  const additional = ids.map(id => nodes.get(id)!);
  // Reserve one new parent edge without mutating its children.
  sceneStorageBytes(scene, Math.min(budget, SCENE_TRANSIENT_BYTES) - 16, additional);
  if (parentId !== undefined) {
    let edges = 1;
    for (const values of [scene.nodes, additional]) for (const node of values) edges += node.type === 'nTRN' ? 1 : node.type === 'nGRP' ? node.children.length : 0;
    checkCount(edges, SCENE_RESOURCE_LIMITS.edges, 'edge count');
  }
  return ids;
}
export function duplicateSceneObject(scene: VoxScene, nodeId: number, parentId?: number) {
  const originalIds = preflightSceneDuplicate(scene, nodeId, parentId), parent = groupFor(scene, parentId);
  const nodeIds = allocateIds(scene, originalIds.length), mapping = new Map(originalIds.map((id, i) => [id, nodeIds[i]!]));
  const nodes = indexScene(scene).nodes;
  for (const id of originalIds) {
    const node = structuredClone(nodes.get(id)!); node.id = mapping.get(id)!;
    if (node.type === 'nTRN') node.childId = mapping.get(node.childId)!;
    if (node.type === 'nGRP') node.children = node.children.map(child => mapping.get(child)!);
    scene.nodes.push(node);
  }
  const newId = mapping.get(nodeId)!; parent?.children.push(newId);
  return { nodeId: newId, nodeIds };
}
export function removeSceneObject(scene: VoxScene, nodeId: number) {
  const candidates = subtree(scene, nodeId), protectedIds = new Set<number>();
  for (const node of scene.nodes) {
    if (node.type === 'nTRN' && node.childId === nodeId && !candidates.has(node.id)) throw new Error('Cannot remove the required child of a transform; remove its owning transform instead');
    if (!candidates.has(node.id)) for (const child of childrenOf(node)) if (child !== nodeId && candidates.has(child)) protectedIds.add(child);
  }
  // Protect the complete closure, not only directly shared nodes: descendants can still be in use.
  const nodes = indexScene(scene).nodes, stack = [...protectedIds];
  while (stack.length) for (const child of childrenOf(nodes.get(stack.pop()!)!)) {
    if (!protectedIds.has(child)) { protectedIds.add(child); stack.push(child); }
  }
  const removedNodeIds = [...candidates].filter(id => !protectedIds.has(id)), removed = new Set(removedNodeIds);
  scene.nodes = scene.nodes.filter(node => !removed.has(node.id));
  for (const node of scene.nodes) if (node.type === 'nGRP') node.children = node.children.filter(id => !removed.has(id));
  return { removedNodeIds };
}
export function reparentSceneObject(scene: VoxScene, nodeId: number, parentId?: number) {
  const parent = groupFor(scene, parentId), reachable = subtree(scene, nodeId);
  if (parentId !== undefined && reachable.has(parentId)) throw new Error('Reparent would create a cycle');
  if (scene.nodes.some(n => n.type === 'nTRN' && n.childId === nodeId)) throw new Error('Cannot detach the required child of a transform; reparent its owning transform instead');
  for (const node of scene.nodes) if (node.type === 'nGRP') node.children = node.children.filter(id => id !== nodeId);
  parent?.children.push(nodeId);
}
export function groupFor(scene: VoxScene, parentId?: number | undefined) {
  if (parentId === undefined) return undefined;
  const node = indexScene(scene).nodes.get(parentId);
  if (node?.type !== 'nGRP') throw new Error('Parent must be an existing group node');
  return node;
}
function allocateIds(scene: VoxScene, count: number): number[] {
  const used = new Set(scene.nodes.map(n => n.id)); const ids: number[] = [];
  for (let id = 0; ids.length < count; id++) {
    if (id > MAX_ID) throw new Error('Scene node id space exhausted');
    if (!used.has(id)) ids.push(id);
  }
  return ids;
}
export function preflightSceneAddition(scene: VoxScene, source: VoxModelData, budget = SCENE_TRANSIENT_BYTES, parentId?: number): void {
  const current = sceneStorageBytes(scene, Math.min(budget, SCENE_TRANSIENT_BYTES));
  preflightSceneModels([source], Math.max(0, SCENE_TRANSIENT_BYTES - current));
  checkCount(scene.nodes.length + 2, SCENE_RESOURCE_LIMITS.nodes, 'node count');
  let edges = parentId === undefined ? 1 : 2;
  for (const node of scene.nodes) edges += node.type === 'nTRN' ? 1 : node.type === 'nGRP' ? node.children.length : 0;
  checkCount(edges, SCENE_RESOURCE_LIMITS.edges, 'edge count');
  // Use references only; the estimator never visits or copies voxel elements.
  sceneStorageBytes({ ...scene, models: [...scene.models, source] }, Math.min(budget, SCENE_TRANSIENT_BYTES) - 2048, [
    { type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames: [{ _t: '0 0 0' }] },
    { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] },
  ]);
}
export function addSceneObject(scene: VoxScene, source: VoxModelData, options: { parentId?: number | undefined; layerId: number; translation: [number, number, number]; remap: 'error' | 'nearest' }) {
  preflightSceneAddition(scene, source, SCENE_TRANSIENT_BYTES, options.parentId);
  const parent = groupFor(scene, options.parentId);
  if (options.layerId !== -1 && !scene.layers.some(l => l.id === options.layerId)) throw new Error('Scene layer not found');
  let model = cloneModel(source);
  const reference = scenePalette(scene), diff = paletteMismatch(reference, model.palette ?? defaultPalette());
  if (diff) {
    if (options.remap !== 'nearest') throw new Error(`Palette mismatch at index ${diff.index} (scene ${diff.a}, model ${diff.b}); use remap 'nearest'`);
    model = remapModelToPalette(model, reference);
  }
  if (scene.models[0]?.palette) model.palette = new Uint32Array(reference); else delete model.palette;
  const [nodeId, shapeId] = allocateIds(scene, 2) as [number, number];
  const modelIndex = scene.models.length;
  scene.models.push(model);
  scene.nodes.push({ type: 'nTRN', id: nodeId, attributes: {}, childId: shapeId, layerId: options.layerId, frames: [{ _t: options.translation.join(' ') }] }, { type: 'nSHP', id: shapeId, attributes: {}, models: [{ modelId: modelIndex, attributes: {} }] });
  parent?.children.push(nodeId);
  return { nodeId, shapeId, modelIndex };
}

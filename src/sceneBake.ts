import { applyRotation, composeRotations, IDENTITY_ROTATION } from './rotation.js';
import type { Vec3 } from './rotation.js';
import { parseTranslation, scenePalette } from './scene.js';
import type { SceneNode, VoxScene } from './scene.js';
import type { VoxModelData, Voxel } from './vox.js';

/**
 * Transform baking: walks the scene graph (nTRN -> nGRP -> nSHP), accumulates rotation and translation and writes
 * voxels into world space.
 *
 * Pivot rule (unverified against the application): a model cell (x, y, z) is first moved to the offset
 * (x - floor(sizeX / 2), ...) from the model's pivot cell, rotated by `_r`, then translated by `_t`.
 */
export interface Instance {
  modelId: number;
  rotation: number;
  translation: Vec3;
  /** Transform node ids from the root down to the shape. */
  path: number[];
  hidden: boolean;
}
export interface BakeOptions {
  /** Include instances on hidden layers or with `_hidden` set (default false). */
  includeHidden?: boolean;
  /** Animation frame used to pick a transform frame and a shape model (default 0). */
  frame?: number;
}
export interface BakedPart { model: VoxModelData; /** World coordinates of the model's minimum corner. */ origin: Vec3 }
export interface FlattenResult { parts: BakedPart[]; instances: number; skippedHidden: number }

export const MAX_BAKE_VOXELS = 8_000_000;
const MAX_SPAN = 1 << 16;

export function collectInstances(scene: VoxScene, options: BakeOptions = {}): Instance[] {
  const frame = options.frame ?? 0;
  if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer');
  if (!scene.nodes.length) return scene.models.map((_, modelId) => ({ modelId, rotation: IDENTITY_ROTATION, translation: [0, 0, 0] as Vec3, path: [], hidden: false }));
  const byId = new Map<number, SceneNode>(scene.nodes.map(n => [n.id, n]));
  const layers = new Map(scene.layers.map(l => [l.id, l]));
  const referenced = new Set<number>();
  for (const n of scene.nodes) { if (n.type === 'nTRN') referenced.add(n.childId); else if (n.type === 'nGRP') n.children.forEach(c => referenced.add(c)); }
  const out: Instance[] = [];
  const visit = (id: number, rotation: number, translation: Vec3, path: number[], hidden: boolean): void => {
    const node = byId.get(id); if (!node) throw new Error('Missing scene node reference');
    if (node.type === 'nTRN') {
      const f = node.frames[Math.min(frame, node.frames.length - 1)]!;
      const r = f._r === undefined ? IDENTITY_ROTATION : Number(f._r);
      const t = f._t === undefined ? [0, 0, 0] as Vec3 : parseTranslation(f._t);
      const rotated = applyRotation(rotation, t);
      const isHidden = hidden || node.attributes._hidden === '1' || (node.layerId !== -1 && layers.get(node.layerId)?.attributes._hidden === '1');
      visit(node.childId, composeRotations(rotation, r), [translation[0] + rotated[0], translation[1] + rotated[1], translation[2] + rotated[2]], [...path, id], isHidden);
    } else if (node.type === 'nGRP') node.children.forEach(c => visit(c, rotation, translation, path, hidden));
    else {
      const entry = node.models.find(m => m.attributes._f === String(frame)) ?? node.models[0]!;
      out.push({ modelId: entry.modelId, rotation, translation, path, hidden });
    }
  };
  for (const n of scene.nodes) if (!referenced.has(n.id)) visit(n.id, IDENTITY_ROTATION, [0, 0, 0], [], false);
  return out;
}

/** Applies a rotation and translation to one model; returns voxels in the transformed coordinate frame. */
export function transformModelVoxels(model: VoxModelData, rotation: number, translation: Vec3): Voxel[] {
  const cx = Math.floor(model.sizeX / 2), cy = Math.floor(model.sizeY / 2), cz = Math.floor(model.sizeZ / 2);
  return model.voxels.map(v => {
    const [x, y, z] = applyRotation(rotation, [v.x - cx, v.y - cy, v.z - cz]);
    return { x: x + translation[0], y: y + translation[1], z: z + translation[2], i: v.i };
  });
}

function toParts(voxels: Voxel[], palette: Uint32Array | undefined, split: boolean): BakedPart[] {
  if (!voxels.length) throw new Error('Scene contains no visible voxels to flatten');
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of voxels) { const c = [v.x, v.y, v.z]; for (let a = 0; a < 3; a++) { if (c[a]! < min[a]!) min[a] = c[a]!; if (c[a]! > max[a]!) max[a] = c[a]!; } }
  const span = [0, 1, 2].map(a => max[a]! - min[a]! + 1);
  if (span.some(n => n > MAX_SPAN)) throw new Error(`Flattened scene spans ${span.join('x')} cells, which is too large`);
  if (!split && span.some(n => n > 256)) throw new Error(`Flattened scene is ${span.join('x')} voxels, which exceeds the 256 per axis model limit; pass splitIntoChunks to get several models`);
  const tiles = new Map<string, { tile: Vec3; cells: Map<number, number> }>();
  for (const v of voxels) {
    const lx = v.x - min[0], ly = v.y - min[1], lz = v.z - min[2];
    const tile: Vec3 = [Math.floor(lx / 256), Math.floor(ly / 256), Math.floor(lz / 256)];
    const k = tile.join(',');
    let entry = tiles.get(k); if (!entry) { entry = { tile, cells: new Map() }; tiles.set(k, entry); }
    entry.cells.set((lx - tile[0] * 256) + 256 * ((ly - tile[1] * 256) + 256 * (lz - tile[2] * 256)), v.i);
  }
  const parts: BakedPart[] = [];
  for (const { tile, cells } of tiles.values()) {
    const list: Voxel[] = []; const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const [key, i] of cells) {
      const x = key & 255, y = (key >> 8) & 255, z = key >> 16;
      list.push({ x, y, z, i });
      if (x < lo[0]!) lo[0] = x; if (y < lo[1]!) lo[1] = y; if (z < lo[2]!) lo[2] = z;
      if (x > hi[0]!) hi[0] = x; if (y > hi[1]!) hi[1] = y; if (z > hi[2]!) hi[2] = z;
    }
    const model: VoxModelData = { sizeX: hi[0]! - lo[0]! + 1, sizeY: hi[1]! - lo[1]! + 1, sizeZ: hi[2]! - lo[2]! + 1, voxels: list.map(v => ({ x: v.x - lo[0]!, y: v.y - lo[1]!, z: v.z - lo[2]!, i: v.i })), ...(palette ? { palette: new Uint32Array(palette) } : {}) };
    parts.push({ model, origin: [min[0] + tile[0] * 256 + lo[0]!, min[1] + tile[1] * 256 + lo[1]!, min[2] + tile[2] * 256 + lo[2]!] });
  }
  return parts.sort((a, b) => a.origin[2] - b.origin[2] || a.origin[1] - b.origin[1] || a.origin[0] - b.origin[0]);
}

/** Merges every visible instance into world-space model(s). Later instances overwrite earlier ones. */
export function flattenScene(scene: VoxScene, options: BakeOptions & { splitIntoChunks?: boolean } = {}): FlattenResult {
  const all = collectInstances(scene, options);
  const used = all.filter(i => options.includeHidden || !i.hidden);
  let total = 0; for (const i of used) total += scene.models[i.modelId]!.voxels.length;
  if (total > MAX_BAKE_VOXELS) throw new Error(`Flattening would produce more than ${MAX_BAKE_VOXELS} voxels`);
  const voxels: Voxel[] = [];
  for (const i of used) for (const v of transformModelVoxels(scene.models[i.modelId]!, i.rotation, i.translation)) voxels.push(v);
  const palette = scene.models[0]!.palette ? scenePalette(scene) : undefined;
  return { parts: toParts(voxels, palette, options.splitIntoChunks === true), instances: used.length, skippedHidden: all.length - used.length };
}

/** Bakes the Nth instance of one model (instances are numbered in document order) into world space. */
export function bakeModelInstance(scene: VoxScene, modelIndex: number, instance = 0, options: BakeOptions = {}): BakedPart {
  const model = scene.models[modelIndex]; if (!model) throw new Error('Scene model index not found');
  const found = collectInstances(scene, options).filter(i => i.modelId === modelIndex);
  if (!found.length) throw new Error('Model is not referenced by any scene node, so there is no transform to bake');
  const chosen = found[instance]; if (!chosen) throw new Error(`Model has ${found.length} instance(s); instance ${instance} does not exist`);
  const voxels = transformModelVoxels(model, chosen.rotation, chosen.translation);
  return toParts(voxels, model.palette, false)[0]!;
}

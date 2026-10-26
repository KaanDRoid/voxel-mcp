import fs from "node:fs";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ModelRegistry, cloneModel } from "./model.js";
import { cloneScene, createVOXScene, decodeVOXScene, encodeVOXScene, estimateSceneBytes, indexScene, listScene, paletteMismatch, scenePalette, setSceneNodeAttributes, setSceneTransform, validateScene } from "./scene.js";
import type { VoxScene } from "./scene.js";
import { bakeModelInstance, flattenScene } from "./sceneBake.js";
import { remapModelToPalette } from "./paletteRemap.js";
import { defaultPalette } from "./vox.js";
import { RENDER_OBJECT_TYPES } from "./voxChunks.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const dictionary = z.record(z.string().max(128), z.string().max(4096)).refine(v => Object.keys(v).length <= 64, "At most 64 properties are supported");
const lenientFlag = z.boolean().default(false).describe("Recover from duplicate voxels, invalid UTF-8 and malformed render chunks instead of failing; problems are returned as warnings");

interface SceneEntry { scene: VoxScene; /** Serialized form, filled lazily and dropped on every edit. */ bytes?: Buffer }

/**
 * Scenes are kept parsed in memory. Edits run on a copy-on-write snapshot that replaces the stored scene only
 * after validation succeeds, so a failed edit cannot alter an open scene. Serialization happens in save_scene.
 */
export function registerSceneTools(register: RegisterTool, registry: ModelRegistry): void {
  const scenes = new Map<string, SceneEntry>();
  let nextId = 1;
  const entry = (sceneId: string): SceneEntry => {
    const found = scenes.get(sceneId);
    if (!found) throw new Error(`Scene ${sceneId} not found`);
    return found;
  };
  /** Read-only view of the stored scene (never mutate it). */
  const peek = (sceneId: string): VoxScene => entry(sceneId).scene;
  /** Editable snapshot of the stored scene; changes only take effect through commit(). */
  const get = (sceneId: string): VoxScene => cloneScene(entry(sceneId).scene);
  const commit = (scene: VoxScene, sceneId?: string): string => {
    if (!sceneId && scenes.size >= 8) throw new Error("Scene limit exceeded (8)");
    validateScene(scene);
    const size = estimateSceneBytes(scene);
    const total = [...scenes].reduce((sum, [id, data]) => sum + (id === sceneId ? 0 : estimateSceneBytes(data.scene)), size);
    if (total > 64 * 1024 * 1024) throw new Error("Scene storage limit exceeded (64 MiB)");
    const id = sceneId ?? `s${nextId++}`;
    scenes.set(id, { scene });
    return id;
  };
  const serialized = (e: SceneEntry): Buffer => (e.bytes ??= encodeVOXScene(e.scene));
  const index = (scene: VoxScene, modelIndex: number) => {
    if (!scene.models[modelIndex]) throw new Error("Scene model index not found");
    return scene.models[modelIndex]!;
  };
  register({ name: "create_scene", description: "Create a scene with named objects and a default layer from models sharing a palette", inputSchema: z.object({ modelIds: z.array(z.string()).min(1).max(64) }).strict() }, async ({ modelIds }) => {
    const scene = createVOXScene(modelIds.map(id => registry.get(id)));
    scene.layers.push({ id: 0, attributes: { _name: "Default" } });
    scene.nodes.push({ type: "nTRN", id: 0, attributes: { _name: "Scene" }, childId: 1, layerId: -1, frames: [{ _t: "0 0 0" }] });
    scene.nodes.push({ type: "nGRP", id: 1, attributes: {}, children: [] });
    const group = scene.nodes[1]!;
    let x = 0;
    modelIds.forEach((id, i) => {
      const nodeId = 2 + i * 2;
      if (group.type === "nGRP") group.children.push(nodeId);
      scene.nodes.push({ type: "nTRN", id: nodeId, attributes: { _name: `Model ${id}` }, childId: nodeId + 1, layerId: 0, frames: [{ _t: `${x} 0 0` }] });
      scene.nodes.push({ type: "nSHP", id: nodeId + 1, attributes: {}, models: [{ modelId: i, attributes: {} }] });
      x += scene.models[i]!.sizeX + 4;
    });
    return text({ sceneId: commit(scene) });
  });
  register({ name: "load_scene", description: "Load a complete VOX scene, preserving unknown chunks and metadata. Strict by default; lenient mode returns warnings for recovered problems", inputSchema: z.object({ path: z.string(), lenient: lenientFlag }).strict() }, async ({ path, lenient }) => {
    const warnings: string[] = [];
    const scene = decodeVOXScene(fs.readFileSync(path), { lenient, warnings });
    return text({ sceneId: commit(scene), ...(warnings.length ? { warnings } : {}) });
  });
  register({ name: "load_vox_models", description: "Load every model of a (multi-model or animated) .vox file into the model registry and open the file as a scene; returns one registry id per scene model. Transforms are stored in the scene, not baked", inputSchema: z.object({ path: z.string(), lenient: lenientFlag }).strict() }, async ({ path, lenient }) => {
    const warnings: string[] = [];
    const scene = decodeVOXScene(fs.readFileSync(path), { lenient, warnings });
    const models = scene.models.map((model, modelIndex) => {
      const { id } = registry.create(model.sizeX, model.sizeY, model.sizeZ);
      registry.set(id, model);
      return { modelIndex, id, size: [model.sizeX, model.sizeY, model.sizeZ], voxelCount: model.voxels.length };
    });
    return text({ sceneId: commit(scene), models, ...(warnings.length ? { warnings } : {}) });
  });
  register({ name: "save_scene", description: "Save a complete VOX scene without discarding unknown chunks", inputSchema: z.object({ sceneId: z.string(), path: z.string() }).strict() }, async ({ sceneId, path }) => {
    fs.writeFileSync(path, serialized(entry(sceneId)));
    return text({ sceneId, path });
  });
  register({ name: "list_scenes", description: "List scene identifiers and model counts in this session", inputSchema: z.object({}).strict() }, async () => text([...scenes].map(([sceneId, e]) => ({ sceneId, models: e.scene.models.length, bytes: serialized(e).length }))));
  register({ name: "get_scene_info", description: "Inspect scene models, transform/group/shape nodes, layers, materials and render settings", inputSchema: z.object({ sceneId: z.string() }).strict() }, async ({ sceneId }) => text(listScene(peek(sceneId))));
  register({ name: "delete_scene", description: "Remove a scene from this session (not undoable)", inputSchema: z.object({ sceneId: z.string() }).strict() }, async ({ sceneId }) => {
    entry(sceneId); scenes.delete(sceneId); return text({ deleted: sceneId });
  });
  register({ name: "extract_scene_model", description: "Copy one scene model into the editable model registry. With bake the model is rotated and positioned by its scene transform (orientations are the 24 right-angle rotations) and the world position of its minimum corner is returned as origin; the pivot rule is unverified against the application", inputSchema: z.object({ sceneId: z.string(), modelIndex: z.number().int().min(0), bake: z.boolean().default(false), instance: z.number().int().min(0).default(0).describe("Which placement to bake when the model is used several times (document order)") }).strict() }, async ({ sceneId, modelIndex, bake, instance }) => registry.transaction(async () => {
    const scene = peek(sceneId);
    const model = index(scene, modelIndex);
    const baked = bake ? bakeModelInstance(scene, modelIndex, instance, { includeHidden: true }) : undefined;
    const source = baked?.model ?? model;
    const { id } = registry.create(source.sizeX, source.sizeY, source.sizeZ);
    registry.set(id, source);
    return text({ id, ...(baked ? { origin: baked.origin } : {}) });
  }));
  register({ name: "flatten_scene", description: "Merge all visible scene objects into one world-space model in the registry, applying every rotation and translation. Hidden layers are skipped unless includeHidden is set; results above 256 voxels per axis fail unless splitIntoChunks is set. origin is the world position of each model's minimum corner", inputSchema: z.object({ sceneId: z.string(), includeHidden: z.boolean().default(false), frame: z.number().int().min(0).default(0), splitIntoChunks: z.boolean().default(false) }).strict() }, async ({ sceneId, includeHidden, frame, splitIntoChunks }) => registry.transaction(async () => {
    const result = flattenScene(peek(sceneId), { includeHidden, frame, splitIntoChunks });
    const models = result.parts.map(part => {
      const { id } = registry.create(part.model.sizeX, part.model.sizeY, part.model.sizeZ);
      registry.set(id, part.model);
      return { id, origin: part.origin, size: [part.model.sizeX, part.model.sizeY, part.model.sizeZ], voxelCount: part.model.voxels.length };
    });
    return text({ models, instances: result.instances, skippedHidden: result.skippedHidden });
  }));
  register({ name: "replace_scene_model", description: "Replace scene geometry from an editable model while retaining scene nodes and metadata. A model without a palette is read with the default palette; if its palette differs from the scene palette the call fails (naming the first differing index and both colors) unless remap is 'nearest'", inputSchema: z.object({ sceneId: z.string(), modelIndex: z.number().int().min(0), id: z.string(), remap: z.enum(["error", "nearest"]).default("error") }).strict() }, async ({ sceneId, modelIndex, id, remap }) => {
    const scene = get(sceneId); index(scene, modelIndex);
    let incoming = cloneModel(registry.get(id));
    const others = scene.models.filter((_, i) => i !== modelIndex);
    if (others.length) {
      const reference = scenePalette({ ...scene, models: others });
      const diff = paletteMismatch(reference, incoming.palette ?? defaultPalette());
      if (diff) {
        if (remap !== "nearest") throw new Error(`Palette mismatch: model ${id}${incoming.palette ? "" : " has no palette (default palette assumed) and"} differs from the scene palette at index ${diff.index} (scene ${diff.a}, model ${diff.b}). Use remap 'nearest' to map the model's colors onto the scene palette`);
        incoming = remapModelToPalette(incoming, reference);
      }
      if (others[0]!.palette) incoming.palette = new Uint32Array(reference);
      else delete incoming.palette;
    }
    scene.models[modelIndex] = incoming;
    commit(scene, sceneId);
    return text({ sceneId, modelIndex });
  });
  register({ name: "set_scene_node", description: "Update node attributes and transform translation/packed rotation without changing geometry", inputSchema: z.object({ sceneId: z.string(), nodeId: z.number().int().min(0), attributes: dictionary.optional(), translation: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional(), rotation: z.number().int().min(0).max(127).optional(), frame: z.number().int().min(0).default(0), layerId: z.number().int().min(-1).optional() }).strict() }, async ({ sceneId, nodeId, attributes, translation, rotation, frame, layerId }) => {
    const scene = get(sceneId);
    const lookup = indexScene(scene);
    const node = lookup.nodes.get(nodeId);
    if (!node) throw new Error("Scene node not found");
    if (attributes) setSceneNodeAttributes(scene, nodeId, attributes, lookup);
    if (translation || rotation !== undefined) {
      const current = node.type === "nTRN" ? node.frames[frame]?._t ?? "0 0 0" : "0 0 0";
      setSceneTransform(scene, nodeId, translation ?? current.trim().split(/\s+/).map(Number) as [number, number, number], rotation, frame, lookup);
    }
    if (layerId !== undefined) {
      if (node.type !== "nTRN") throw new Error("Only transform nodes have layers");
      node.layerId = layerId;
    }
    commit(scene, sceneId); return text({ sceneId, nodeId });
  });
  register({ name: "set_scene_layer", description: "Create or update layer attributes, including _name and _hidden", inputSchema: z.object({ sceneId: z.string(), layerId: z.number().int().min(0), attributes: dictionary }).strict() }, async ({ sceneId, layerId, attributes }) => {
    const scene = get(sceneId), layer = indexScene(scene).layers.get(layerId);
    if (layer) layer.attributes = { ...layer.attributes, ...attributes };
    else scene.layers.push({ id: layerId, attributes });
    commit(scene, sceneId); return text({ sceneId, layerId });
  });
  register({ name: "set_scene_render_object", description: "Create or merge low-level native rOBJ render settings by type. Properties are string-valued file metadata, not physical lighting units or renderer automation", inputSchema: z.object({ sceneId: z.string(), type: z.enum(RENDER_OBJECT_TYPES), properties: dictionary }).strict() }, async ({ sceneId, type, properties }) => {
    if (properties._type !== undefined && properties._type !== type) throw new Error("properties._type must match the explicit render object type");
    const scene = get(sceneId), object = scene.render.objects.find(o => o.type === type);
    const attributes = { ...object?.attributes, ...properties, _type: type };
    if (object) object.attributes = attributes;
    else scene.render.objects.push({ type, attributes });
    commit(scene, sceneId); return text({ sceneId, type });
  });
  register({ name: "set_scene_camera", description: "Create or merge a native rCAM camera slot (0..9) using string-valued file metadata such as _mode, _focus, _angle and _fov; does not control the native renderer", inputSchema: z.object({ sceneId: z.string(), cameraId: z.number().int().min(0).max(9), properties: dictionary }).strict() }, async ({ sceneId, cameraId, properties }) => {
    const scene = get(sceneId), camera = scene.render.cameras.find(c => c.id === cameraId);
    if (camera) camera.attributes = { ...camera.attributes, ...properties };
    else scene.render.cameras.push({ id: cameraId, attributes: { ...properties } });
    commit(scene, sceneId); return text({ sceneId, cameraId });
  });
  register({ name: "set_scene_material", description: "Create or update a palette material dictionary, such as _type, _rough and _metal. Files written by the application carry material ids 1..256; the exact mapping of id 256 to a palette slot is unverified", inputSchema: z.object({ sceneId: z.string(), index: z.number().int().min(1).max(256), properties: dictionary }).strict() }, async ({ sceneId, index, properties }) => {
    const scene = get(sceneId), material = indexScene(scene).materials.get(index);
    if (material) material.attributes = { ...material.attributes, ...properties };
    else scene.materials.push({ id: index, attributes: properties });
    commit(scene, sceneId); return text({ sceneId, index });
  });
}

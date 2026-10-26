import fs from "node:fs";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ModelRegistry, cloneModel } from "./model.js";
import { createVOXScene, decodeVOXScene, encodeVOXScene, listScene, setSceneNodeAttributes, setSceneTransform } from "./scene.js";
import type { VoxScene } from "./scene.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const dictionary = z.record(z.string().max(128), z.string().max(4096)).refine(v => Object.keys(v).length <= 64, "At most 64 properties are supported");

/** Store scenes as bounded serialized documents so failed edits cannot alter an open scene. */
export function registerSceneTools(register: RegisterTool, registry: ModelRegistry): void {
  const scenes = new Map<string, Buffer>();
  let nextId = 1;
  const get = (sceneId: string): VoxScene => {
    const bytes = scenes.get(sceneId);
    if (!bytes) throw new Error(`Scene ${sceneId} not found`);
    return decodeVOXScene(bytes);
  };
  const commit = (scene: VoxScene, sceneId?: string): string => {
    if (!sceneId && scenes.size >= 8) throw new Error("Scene limit exceeded (8)");
    const bytes = encodeVOXScene(scene);
    const total = [...scenes].reduce((sum, [id, data]) => sum + (id === sceneId ? 0 : data.length), bytes.length);
    if (total > 64 * 1024 * 1024) throw new Error("Scene storage limit exceeded (64 MiB)");
    const id = sceneId ?? `s${nextId++}`;
    scenes.set(id, bytes);
    return id;
  };
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
  register({ name: "load_scene", description: "Load a complete VOX scene, preserving unknown chunks and metadata", inputSchema: z.object({ path: z.string() }).strict() }, async ({ path }) => text({ sceneId: commit(decodeVOXScene(fs.readFileSync(path))) }));
  register({ name: "save_scene", description: "Save a complete VOX scene without discarding unknown chunks", inputSchema: z.object({ sceneId: z.string(), path: z.string() }).strict() }, async ({ sceneId, path }) => {
    get(sceneId);
    fs.writeFileSync(path, scenes.get(sceneId)!);
    return text({ sceneId, path });
  });
  register({ name: "list_scenes", description: "List scene identifiers and model counts in this session", inputSchema: z.object({}).strict() }, async () => text([...scenes].map(([sceneId, bytes]) => ({ sceneId, models: decodeVOXScene(bytes).models.length, bytes: bytes.length }))));
  register({ name: "get_scene_info", description: "Inspect scene models, transform/group/shape nodes, layers and materials", inputSchema: z.object({ sceneId: z.string() }).strict() }, async ({ sceneId }) => text(listScene(get(sceneId))));
  register({ name: "delete_scene", description: "Remove a scene from this session (not undoable)", inputSchema: z.object({ sceneId: z.string() }).strict() }, async ({ sceneId }) => {
    get(sceneId); scenes.delete(sceneId); return text({ deleted: sceneId });
  });
  register({ name: "extract_scene_model", description: "Copy one scene model into the editable model registry; scene transforms are not baked", inputSchema: z.object({ sceneId: z.string(), modelIndex: z.number().int().min(0) }).strict() }, async ({ sceneId, modelIndex }) => registry.transaction(async () => {
    const model = index(get(sceneId), modelIndex);
    const { id } = registry.create(model.sizeX, model.sizeY, model.sizeZ);
    registry.set(id, model);
    return text({ id });
  }));
  register({ name: "replace_scene_model", description: "Replace scene geometry from an editable model while retaining scene nodes and metadata", inputSchema: z.object({ sceneId: z.string(), modelIndex: z.number().int().min(0), id: z.string() }).strict() }, async ({ sceneId, modelIndex, id }) => {
    const scene = get(sceneId); index(scene, modelIndex);
    scene.models[modelIndex] = cloneModel(registry.get(id));
    commit(scene, sceneId);
    return text({ sceneId, modelIndex });
  });
  register({ name: "set_scene_node", description: "Update node attributes and transform translation/packed rotation without changing geometry", inputSchema: z.object({ sceneId: z.string(), nodeId: z.number().int().min(0), attributes: dictionary.optional(), translation: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional(), rotation: z.number().int().min(0).max(127).optional(), frame: z.number().int().min(0).default(0), layerId: z.number().int().min(-1).optional() }).strict() }, async ({ sceneId, nodeId, attributes, translation, rotation, frame, layerId }) => {
    const scene = get(sceneId);
    const node = scene.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error("Scene node not found");
    if (attributes) setSceneNodeAttributes(scene, nodeId, attributes);
    if (translation || rotation !== undefined) {
      const current = node.type === "nTRN" ? node.frames[frame]?._t ?? "0 0 0" : "0 0 0";
      setSceneTransform(scene, nodeId, translation ?? current.trim().split(/\s+/).map(Number) as [number, number, number], rotation, frame);
    }
    if (layerId !== undefined) {
      if (node.type !== "nTRN") throw new Error("Only transform nodes have layers");
      node.layerId = layerId;
    }
    commit(scene, sceneId); return text({ sceneId, nodeId });
  });
  register({ name: "set_scene_layer", description: "Create or update layer attributes, including _name and _hidden", inputSchema: z.object({ sceneId: z.string(), layerId: z.number().int().min(0), attributes: dictionary }).strict() }, async ({ sceneId, layerId, attributes }) => {
    const scene = get(sceneId), layer = scene.layers.find(l => l.id === layerId);
    if (layer) layer.attributes = { ...layer.attributes, ...attributes };
    else scene.layers.push({ id: layerId, attributes });
    commit(scene, sceneId); return text({ sceneId, layerId });
  });
  register({ name: "set_scene_material", description: "Create or update a palette material dictionary, such as _type, _rough and _metal. Files written by the application carry material ids 1..256; the exact mapping of id 256 to a palette slot is unverified", inputSchema: z.object({ sceneId: z.string(), index: z.number().int().min(1).max(256), properties: dictionary }).strict() }, async ({ sceneId, index, properties }) => {
    const scene = get(sceneId), material = scene.materials.find(m => m.id === index);
    if (material) material.attributes = { ...material.attributes, ...properties };
    else scene.materials.push({ id: index, attributes: properties });
    commit(scene, sceneId); return text({ sceneId, index });
  });
}

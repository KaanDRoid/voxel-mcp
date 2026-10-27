import type { CallToolResult } from "@modelcontextprotocol/server";

export const TOOLSETS = ["core", "modeling", "scene", "animation", "palette", "formats", "shaders", "app"] as const;
export type Toolset = typeof TOOLSETS[number];
export interface PathFieldPolicy { access: "read" | "write"; directory?: boolean }
export interface ToolPolicy {
  toolset: Toolset;
  readOnly: boolean;
  effects: string[];
  pathFields?: Record<string, PathFieldPolicy>;
}

/**
 * Registration metadata source of truth. Effects describe possible effects, not guaranteed
 * changes on every invocation. file-read alone is read-only; clipboard writes are not.
 * Map toolset/effects directly to magicvoxel/toolset and magicvoxel/effects in tool _meta.
 * These hints do not replace file confinement, transactions or app automation opt-in.
 */
const policies = new Map<string, ToolPolicy>();
function declare(toolset: Toolset, names: string, effects: string[] = [], pathFields?: Record<string, PathFieldPolicy>): void {
  for (const name of names.trim().split(/\s+/)) {
    if (policies.has(name)) throw new Error(`Duplicate tool policy: ${name}`);
    policies.set(name, { toolset, readOnly: effects.every(effect => effect === "file-read"), effects, ...(pathFields ? { pathFields } : {}) });
  }
}
const readPath = { path: { access: "read" as const } };
const writePath = { path: { access: "write" as const } };
const writeFolder = { folder: { access: "write" as const, directory: true } };

// Core supplies the model lifecycle shared by every optional group. No optional group
// implicitly enables modeling or another optional group. Native scene keyframes live in
// scene; animation contains the separate AnimationRegistry and its export operations.
declare("core", "list_models get_model_info render_model get_dimensions count_colors measure_distance get_surface_area get_volume find_center detect_symmetry");
declare("core", "create_model clone_model delete_model undo redo", ["model-mutation"]);
declare("core", "load_vox", ["file-read", "model-mutation"], readPath);
declare("core", "save_vox", ["file-write"], writePath);
declare("core", "get_magicavoxel_info list_magicavoxel_samples list_magicavoxel_ibl", ["file-read"]);
declare("core", "load_magicavoxel_sample", ["file-read", "model-mutation"]);

declare("modeling", `
  add_detail_noise align_to_ground apply_gradient apply_noise apply_pattern auto_uv_color
  bevel_edges boolean_op center_model clear_model clear_region crop_to_content deduplicate_voxels
  dilate draw_line erode extrude_face fill_box fill_cone fill_cylinder fill_pyramid fill_sphere
  fill_torus flip_model flood_fill generate_character generate_city_block generate_creature
  generate_customer generate_from_prompt generate_furniture generate_house generate_nature
  generate_staff generate_structure generate_terrain generate_tree generate_vehicle
  generate_venue_character generate_venue_interior generate_weapon hollow_model make_symmetric
  mirror_model outline paste_region randomize_surface_color replace_color rotate_arbitrary
  scale_model set_voxels simplify_model smooth_model transform_rotate90 transform_translate voxelize_text
`, ["model-mutation"]);
declare("modeling", "copy_region", ["clipboard-write"]);
declare("modeling", "image_to_voxel image_to_voxel_colorized image_silhouette_to_3d edge_detect_to_voxel depth_map_to_voxel", ["file-read", "model-mutation"], readPath);
declare("modeling", "multi_view_to_voxel", ["file-read", "model-mutation"], {
  frontPath: { access: "read" }, sidePath: { access: "read" }, topPath: { access: "read" },
});

declare("scene", "list_scenes get_scene_info inspect_scene_animation");
declare("scene", `
  create_scene delete_scene undo_scene redo_scene add_scene_object duplicate_scene_object
  remove_scene_object reparent_scene_object delete_scene_layer replace_scene_model set_scene_node
  set_scene_layer set_scene_render_object set_scene_camera set_scene_material
  set_scene_material_properties apply_scene_lighting_preset set_scene_camera_pose
  set_scene_transform_keyframe set_scene_model_keyframe remove_scene_keyframe animation_to_scene set_scene_animation_range
`, ["scene-mutation"]);
declare("scene", "extract_scene_model flatten_scene", ["model-mutation"]);
declare("scene", "load_scene", ["file-read", "scene-mutation"], readPath);
declare("scene", "load_vox_models", ["file-read", "model-mutation", "scene-mutation"], readPath);
declare("scene", "save_scene", ["file-write"], writePath);

declare("animation", "create_animation set_animation_fps set_animation_loop set_frame_duration duplicate_frame remove_frame reorder_frame add_frame interpolate_frames", ["animation-mutation"]);
declare("animation", "export_animation_spritesheet export_animation_gif", ["file-write"], writePath);
declare("animation", "export_animation_frames", ["file-write"], writeFolder);

declare("palette", "find_nearest_color");
declare("palette", "set_model_palette set_palette_index generate_palette apply_palette_to_model blend_palettes quantize_model sort_palette merge_palettes", ["model-mutation"]);
declare("palette", "load_palette_from_png extract_palette_from_image import_palette_png import_palette_act import_palette_vox remap_model_to_palette", ["file-read", "model-mutation"], readPath);
declare("palette", "save_palette_to_png export_palette_png export_palette_act export_palette_vox", ["file-write"], writePath);
declare("palette", "list_magicavoxel_palettes load_magicavoxel_palette", ["file-read"]);
declare("palette", "apply_magicavoxel_palette", ["file-read", "model-mutation"]);

declare("formats", "export_obj export_ply export_stl export_gltf export_qb export_xraw export_slab6 export_kvx export_raw export_minecraft_schem export_minecraft_schematic", ["file-write"], writePath);
declare("formats", "export_slices", ["file-write"], writeFolder);
declare("formats", "import_obj import_svg import_qb import_xraw import_slab6 import_kvx import_raw import_minecraft_schem", ["file-read", "model-mutation"], readPath);

declare("shaders", "generate_xs_shader_template");
declare("shaders", "list_magicavoxel_shaders", ["file-read"]);
declare("shaders", "list_xs_shaders", ["file-read"], { subdir: { access: "read", directory: true } });
declare("shaders", "read_xs_shader validate_xs_shader", ["file-read"], readPath);
declare("shaders", "write_xs_shader", ["file-write"], writePath);
declare("shaders", "run_xs_shader", ["file-read", "model-mutation"], readPath);

declare("app", "open_in_magicavoxel", ["file-read", "app-launch"], readPath);
declare("app", "attach_magicavoxel_app", ["session-mutation"]);
declare("app", "set_app_camera set_app_animation_timing", ["app-input"]);
declare("app", "export_native_render export_app_camera_snapshot export_native_sequence", ["app-input", "file-write"], writePath);

export const KNOWN_TOOL_NAMES: readonly string[] = Object.freeze([...policies.keys()]);

/** Blank/unset means all tools. Explicit selections add core, never optional dependencies. */
export function selectedToolsets(env: Readonly<Record<string, string | undefined>>): Set<string> | undefined {
  const value = env.MAGICVOXEL_MCP_TOOLSETS;
  if (value === undefined || value.trim() === "") return undefined;
  const selection = new Set<string>(["core"]);
  for (const entry of value.split(",")) {
    const group = entry.trim();
    if (!(TOOLSETS as readonly string[]).includes(group)) {
      throw new Error(`Unknown toolset: ${JSON.stringify(group)}. Known toolsets: ${TOOLSETS.join(", ")}`);
    }
    selection.add(group);
  }
  return selection;
}

export function shouldRegisterTool(name: string, selection: ReadonlySet<string> | undefined): boolean {
  const policy = resolveToolPolicy(name);
  return selection === undefined || policy.toolset === "core" || selection.has(policy.toolset);
}

/**
 * Add structured data without advertising an outputSchema or replacing content blocks.
 * Only a single textual payload is unambiguous; other block types are left intact.
 * Existing structured data and error results remain authoritative and unchanged.
 */
export function enrichToolResult(result: CallToolResult): CallToolResult {
  if (result.isError || "structuredContent" in result) return result;
  const texts = result.content.filter(block => block.type === "text");
  if (texts.length !== 1) return result;
  let value: unknown;
  try { value = JSON.parse(texts[0]!.text); } catch { return result; }
  if (value === null || typeof value !== "object") return result;
  return { ...result, structuredContent: Array.isArray(value) ? { items: value } : value };
}

/** Unknown tools throw, including when all groups are enabled: classification fails closed. */
export function resolveToolPolicy(name: string): ToolPolicy {
  const policy = policies.get(name);
  if (!policy) throw new Error(`Unknown tool policy: ${name}`);
  return {
    ...policy, effects: [...policy.effects],
    ...(policy.pathFields ? { pathFields: Object.fromEntries(Object.entries(policy.pathFields).map(([key, value]) => [key, { ...value }])) } : {}),
  };
}

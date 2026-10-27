# Scene workflows

These tools edit the server's in-memory VOX scene, not an already-open application
window. Save with `save_scene`, then reopen the file in MagicaVoxel to inspect it.
The live application tools are a separate, Windows-only opt-in interface.

## Start with a model

1. Call `create_model` and edit it with primitives or explicit voxels.
2. Call `create_scene` with `modelIds` containing the returned registry model IDs.
3. Call `get_scene_info` to inspect node IDs, scene model indices and layers.

Registry model IDs are strings. Scene model indices and node IDs are integers;
they are different namespaces. Never substitute one for another.

## Objects and layers

- `add_scene_object` copies a registry model into a new transform/shape pair.
  Choose `parentId` from existing group nodes to place it inside that group.
  Omitting the parent creates a new graph root, not a child of the first group.
- `duplicate_scene_object` duplicates a reachable subtree with fresh node IDs.
  The copy shares scene model references, so replacing a referenced scene model
  affects both original and copied placements. Internal shared descendants remain
  shared within the duplicated subtree.
- `reparent_scene_object` changes all group placements of the selected node.
  It preserves local transforms, not world-space placement. Cycles are rejected.
- `remove_scene_object` removes the selected node and descendants that are not
  referenced from outside the removed subtree. It keeps shared descendants and
  model geometry. Remove a transform rather than directly removing its required
  child.
- `set_scene_node` edits a name or visibility attribute, translation, packed
  rotation or layer assignment. Packed rotations encode right-angle axis
  orientations; they are not Euler angles.
- `set_scene_layer` creates or merges a layer, including `_name` and `_hidden`.
- `delete_scene_layer` requires explicit `reassignTo` when transforms use the
  layer. Supply another existing layer or `-1` for no layer.

A scene uses one shared palette. On insertion, `remap: "error"` rejects different
palettes; `remap: "nearest"` maps incoming colors onto the existing scene palette.
Neither choice changes the source registry model.

## Scene undo and redo

`undo_scene` and `redo_scene` require `sceneId`. Their history is independent of
model-registry `undo` and `redo`. Successful graph, layer, material, camera,
render-setting, keyframe and model-replacement edits participate in scene history.
Failed edits and read-only calls preserve redo; a successful new edit clears redo
for that scene only.

History is bounded. An old or oversized snapshot may be evicted, so an undo is not
a permanent backup. Creation and loading start empty history; deleting a scene
discards it. Saving a file does not create an undo entry, and undo never rolls back
files already written to disk. Save important versions under distinct paths.

## Typed materials, lighting and saved cameras

`set_scene_material_properties` accepts a material index, a type (`diffuse`,
`metal`, `glass`, `emit`) and validated optional fields. `roughness`, `metalness`,
`ior` and `emission` use the tool policy range 0..1; `flux` uses 0..4. Metalness
requires `metal`; emission and flux require `emit`. `ior` writes raw `_ior`
metadata, not the physical refractive index field `_ri`.

`apply_scene_lighting_preset` accepts `studio`, `daylight` or `night`. These are
authored patches for `_inf` and `_uni` dictionaries; they do not select an
environment mode, convert physical units or start the renderer.

`set_scene_camera_pose` accepts a slot `cameraId` (0..9), three-component `focus`
and `angle`, integer `radius` and integer `fov`. Vectors use native file order,
without an axis conversion. Only `projection: "perspective"` is exposed; omitted
projection retains the old mode or defaults a new slot to perspective. The tool
does not derive `_frustum` or change a live viewport.

All three preserve unrelated metadata. Low-level `set_scene_material`,
`set_scene_render_object` and `set_scene_camera` remain available for explicit
string-valued native dictionaries.

## Native scene keyframes

- `inspect_scene_animation` reports transform and shape tracks.
- `set_scene_transform_keyframe` inserts or updates a transform by `frameIndex`,
  with translation and/or packed rotation.
- `set_scene_model_keyframe` selects a scene `modelIndex` at `frameIndex` on a
  shape node.
- `remove_scene_keyframe` deletes a key without allowing an empty track.

`frameIndex` addresses native `_f` timeline indices, not positions in an array.
Missing native `_f` values use the entry position as an explicit fallback policy.
Tracks are bounded to 512 keys and indices 0..1,000,000. Editing keys does not
claim native interpolation or playback timing. `flatten_scene` selects both
transform and shape keys by timeline index: it holds the latest key at or before
the requested frame, or uses the earliest key before the first. This is an
explicit baker policy, not a native playback guarantee. Expanded graph traversal
is bounded to 10,000 instances, 100,000 visits and depth 256; shared graphs that
would expand beyond those limits are rejected before expansion.

## Convert frame animations to native scenes

Build a frame-registry animation with `create_animation` and `add_frame`, then
call `animation_to_scene` with its `animationId`. Alternatively pass explicit
registry `modelIds`, optional `durationsMs`, `fps` and `loop`. Select exactly one
source. Every model is copied into the new scene; the source remains independent.

Durations are quantized to timeline ticks; sub-tick source frames are rejected.
Default `nativeTiming:true` copies a distinct native model for every tick,
including the final source hold, and writes sequential shape `_f` keys plus
META `_anim_range`. Clips are bounded to 361 ticks, eight million replicated
voxels and the scene allocation/storage budgets. Sources remain independent.
`nativeTiming:false` explicitly retains sparse start keys without native hold
assurances. The native world/group/object/shape graph and `_loop` are retained.
FPS/duration metadata are descriptive, not a standardized native file FPS field.
See [Native workflows](native-workflows.md) for live speed and render controls.

`set_scene_animation_range` takes `sceneId`, `start` and `end` (inclusive 0..360),
preserves unrelated metadata and participates in scene history.
`inspect_scene_animation` returns the parsed native range.

## Installed palettes

With a configured installation, call `list_magicavoxel_palettes`, then use an
explicit listed name with `load_magicavoxel_palette`. It returns 256 unsigned
little-endian RGBA values (`0xAABBGGRR`) without modifying any model.

`apply_magicavoxel_palette` requires `mode: "recolor"` or `mode: "nearest"`:
recolor keeps voxel indices and changes their colors; nearest remaps source RGB
colors onto nonzero target indices. RGB ties choose the lowest target index;
alpha is ignored by this convenience remap. This is a model-registry edit, so use
model `undo`, not `undo_scene`. Neither tool writes to the installation.

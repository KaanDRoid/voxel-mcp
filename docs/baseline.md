# Baseline

Measured on `master` at commit 9822d0a (Node 22+, Windows, `npm ci` then `npm run check`).

## Tests

- 17 test files before this change (`tests/*.test.ts`), 59 tests reported by the runner: 57 pass, 2 skipped, 0 fail.
- Full `npm test` (build plus all tests): about 11.5 s wall time.

## Tool catalog

A real stdio session (`tools/list`) advertises **120 tools**. The README previously said 107; that was the
count of the first commit. Tools are registered through two paths in the source (`registerTool({...})` in
`src/tools.ts` and `register({...})` in `src/sceneTools.ts`), so grepping the source does not give a reliable number.

The authoritative list is `tests/snapshots/tool-names.json`, checked by `tests/tool-names.test.ts`.
After adding or removing a tool on purpose, rerun the test with `UPDATE_SNAPSHOT=1` and commit the new snapshot.

Names at baseline:

- `add_detail_noise`
- `add_frame`
- `align_to_ground`
- `apply_gradient`
- `apply_noise`
- `apply_palette_to_model`
- `apply_pattern`
- `auto_uv_color`
- `bevel_edges`
- `blend_palettes`
- `boolean_op`
- `center_model`
- `clear_model`
- `clear_region`
- `clone_model`
- `copy_region`
- `count_colors`
- `create_animation`
- `create_model`
- `create_scene`
- `crop_to_content`
- `deduplicate_voxels`
- `delete_model`
- `delete_scene`
- `depth_map_to_voxel`
- `detect_symmetry`
- `dilate`
- `draw_line`
- `duplicate_frame`
- `edge_detect_to_voxel`
- `erode`
- `export_animation_frames`
- `export_animation_gif`
- `export_animation_spritesheet`
- `export_gltf`
- `export_minecraft_schematic`
- `export_obj`
- `export_ply`
- `export_slices`
- `export_stl`
- `extract_palette_from_image`
- `extract_scene_model`
- `extrude_face`
- `fill_box`
- `fill_cone`
- `fill_cylinder`
- `fill_pyramid`
- `fill_sphere`
- `fill_torus`
- `find_center`
- `flip_model`
- `flood_fill`
- `generate_character`
- `generate_city_block`
- `generate_creature`
- `generate_customer`
- `generate_from_prompt`
- `generate_furniture`
- `generate_house`
- `generate_nature`
- `generate_palette`
- `generate_staff`
- `generate_structure`
- `generate_terrain`
- `generate_tree`
- `generate_vehicle`
- `generate_venue_character`
- `generate_venue_interior`
- `generate_weapon`
- `get_dimensions`
- `get_model_info`
- `get_scene_info`
- `get_surface_area`
- `get_volume`
- `hollow_model`
- `image_silhouette_to_3d`
- `image_to_voxel`
- `image_to_voxel_colorized`
- `import_obj`
- `import_svg`
- `interpolate_frames`
- `list_models`
- `list_scenes`
- `load_palette_from_png`
- `load_scene`
- `load_vox`
- `make_symmetric`
- `measure_distance`
- `mirror_model`
- `multi_view_to_voxel`
- `open_in_magicavoxel`
- `outline`
- `paste_region`
- `randomize_surface_color`
- `redo`
- `remove_frame`
- `render_model`
- `reorder_frame`
- `replace_color`
- `replace_scene_model`
- `rotate_arbitrary`
- `save_palette_to_png`
- `save_scene`
- `save_vox`
- `scale_model`
- `set_animation_fps`
- `set_animation_loop`
- `set_frame_duration`
- `set_model_palette`
- `set_palette_index`
- `set_scene_layer`
- `set_scene_material`
- `set_scene_node`
- `set_voxels`
- `simplify_model`
- `smooth_model`
- `transform_rotate90`
- `transform_translate`
- `undo`
- `voxelize_text`

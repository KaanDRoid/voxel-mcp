# MagicaVoxel MCP Server

Model Context Protocol (MCP) server with a broad toolset for procedural voxel modeling, analysis, animation, and MagicaVoxel integration.

## Highlights
- Shape primitives, transforms, boolean ops, region copy/paste, model cloning.
- Advanced image ingestions: colorized voxelization, silhouette extrusion, depth maps, multi-view carving, edge-to-voxel.
- Procedural generators: vehicles, furniture, weapons, structures, creatures, nature, Ankara-style city blocks, venue interiors, and NPC characters (staff/customers).
- Editing/patterns: gradients, textures, erosion/dilation, outline/smooth/bevel, detail noise, surface color randomization.
- Palette management: load/save PNG palettes, generate presets, extract/blend/apply palettes.
- Analysis and smart tools: measurements, symmetry, LOD simplification, voxel text, auto UV coloring.
- Animation helpers: frame registry, interpolation, spritesheet export, GIF placeholder.
- Import/export: VOX, OBJ, PLY, STL, glTF 2.0, PNG slices, simple Minecraft schematic; OBJ/SVG importers.

## Requirements
- Node.js 18+
- MagicaVoxel.exe (optional, required for `open_in_magica`)

## Install & Run
```bash
npm install
npm run build
npm start
```
Development: `npm run dev`

## Key Tools (examples)
- Model management: `create_model`, `list_models`, `clone_model`, `delete_model`, `get_model_info`
- Primitives & editing: `fill_box`, `fill_sphere`, `draw_line`, `transform_translate`, `rotate_arbitrary`, `boolean_op`, `mirror_model`, `hollow_model`, `erode`, `dilate`, `outline`, `smooth_model`, `extrude_face`, `bevel_edges`, `add_detail_noise`
- Patterns/gradients: `apply_pattern`, `apply_gradient`, `randomize_surface_color`
- Image: `image_to_voxel_colorized`, `image_silhouette_to_3d`, `edge_detect_to_voxel`, `depth_map_to_voxel`, `multi_view_to_voxel`
- Generators: `generate_vehicle`, `generate_furniture`, `generate_weapon`, `generate_structure`, `generate_creature`, `generate_nature`, `generate_ankara_block`, `generate_venue_interior`, `generate_venue_character`, `generate_staff`, `generate_customer`
- Palette: `generate_palette`, `extract_palette_from_image`, `apply_palette_to_model`, `blend_palettes`, `set_palette_index`, `save_palette_to_png`
- Analysis: `measure_distance`, `get_surface_area`, `get_volume`, `find_center`, `get_dimensions`, `count_colors`
- Animation: `create_animation`, `add_frame`, `interpolate_frames`, `export_animation_spritesheet`, `export_animation_gif` (throws until encoder is added)
- Import/Export: `save_vox`, `load_vox`, `export_obj`, `export_ply`, `export_slices`, `export_stl`, `export_gltf`, `export_minecraft_schematic`, `import_obj`, `import_svg`
- MagicaVoxel integration: `set_magica_path`, `open_in_magica`

## Usage Snippets
```text
# Hollow sphere
create_model {sizeX:64, sizeY:64, sizeZ:64}
fill_sphere {id:"1", cx:32, cy:32, cz:32, r:20, i:200}
hollow_model {id:"1", thickness:2}
save_vox {id:"1", path:"out/hollow_sphere.vox"}

# Colorized heightmap
image_to_voxel_colorized {path:"input.png", sizeX:128, sizeY:128, sizeZ:64, mode:"heightmap"}
apply_gradient {id:"1", axis:"z", i0:100, i1:200}

# Night venue setup
generate_ankara_block {sizeX:180, sizeY:180, sizeZ:48}
create_model {sizeX:64, sizeY:64, sizeZ:32}
generate_venue_interior {id:"2"}
```

## Notes
- Palette: 256 colors (index 0 = empty). Default palette is grayscale.
- Coordinates: X=right, Y=forward, Z=up.
- Performance: `deduplicate_voxels` helps after heavy ops.
- GIF export currently throws; spritesheet PNG is available.
- Minecraft export uses a simple JSON schematic (not NBT).

## Client Integration (Claude Desktop)
Use `client-config/claude-desktop.json` as a template; build with `npm run build` and run `node dist/index.js` from the repo root.

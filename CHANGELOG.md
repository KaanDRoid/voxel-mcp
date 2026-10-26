# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Palette tools: `import_palette_png`, `import_palette_act`, `import_palette_vox`, `export_palette_png`, `export_palette_act`, `export_palette_vox`, `remap_model_to_palette`, `quantize_model`, `sort_palette`, `find_nearest_color`, `merge_palettes`.
- Voxel format tools: `export_qb`/`import_qb`, `export_xraw`/`import_xraw`, `export_slab6`/`import_slab6`, `export_minecraft_schem`/`import_minecraft_schem` (Sponge v2/v3).
- `export_obj` options `profile` (`basic` or `magica`), `scale`, `axis`, `cw` and `merge`; `export_ply`, `export_stl` and `export_gltf` accept `scale` and `axis` (STL also `merge`).
- `import_obj` solid fill, vertex/material/texture colors, `fit`, `scale` and `axis`, and warnings for open meshes.
- `import_svg` paths, fills, groups, transforms, ellipses, polygons and rounded rectangles, with explicit "unsupported SVG" errors.
- `export_animation_gif` options `quantize`, `dither` and `maxColors`; the result lists `warnings`.

### Changed

- OBJ, glTF, PLY and STL exports now use proper axis rotations (Y-up for OBJ and glTF, Z-up for STL) instead of swapping Y and Z, which mirrored the model. Output sizes are unchanged.
- `import_obj` size parameters are optional; without them the mesh keeps its size (`scale` 1).

### Fixed

- Exports read palette colors in the correct byte order: red and blue were swapped in OBJ, PLY, glTF, slices and the legacy schematic.

## [1.2.0]

### Changed

Breaking renames (the package was never published, so no aliases are provided):

- Product name is now `magicvoxel-mcp` for the npm package, the executable (`bin`) and the MCP server name (was `voxel-mcp` / `magica-mcp`).
- Environment variable `VOXEL_MCP_WORKSPACE` -> `MAGICVOXEL_MCP_WORKSPACE`.
- Tool `generate_ankara_block` -> `generate_city_block`.
- Tool `open_in_magica` -> `open_in_magicavoxel`.
- Resource URIs `magica:models`, `magica:vox/{folder}`, `magica:samples`, `magica:palettes` -> `magicavoxel:models`, `magicavoxel:vox/{folder}`, `magicavoxel:samples`, `magicavoxel:palettes`.
- `generate_venue_character` `role`, `generate_staff` `type` and `generate_customer` `type` now use neutral English values (for example `hostess`, `customer`, `waiter`, `cook`, `police_officer`, `gangster`, `detective`, `bartender`, `retiree`, `farmer`). See each tool's input schema for the full list.
- Prompt-based generation now recognizes English keywords only (`house`, `building`, `home`, `cottage`, `N floors`/`N storeys`, `character`, `humanoid`, `person`, `robot`, `sphere`, `ball`, `globe`).
- All tool descriptions, error messages, comments, tests and documentation are now English and culturally neutral.

### Added

- Language and naming check (`tests/language.test.ts`) that keeps tracked sources ASCII-only and free of locale-specific terms and old names.
- Generic client configuration example `client-config/mcp-client.json`.

## [1.1.0]

### Fixed

- The server now starts against the current MCP SDK, with working tool, resource and prompt registration.
- The VOX reader traverses the MAIN chunk correctly and validates its input; the official default palette is used.

### Added

- Multi-model scenes with transform, group, shape, layer and material metadata; unknown chunks are preserved.
- Undo/redo with transactional rollback, workspace-confined file access and input limits.
- `render_model` PNG previews, GIF export, and glTF/OBJ/STL/PLY/NBT-schematic export corrections.
- Test suite (including real stdio MCP sessions) and continuous integration.

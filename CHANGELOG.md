# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.3.0] - 2026-10-26

### Added

- Opt-in live control of a running MagicaVoxel window on Windows (`MAGICVOXEL_MCP_UI_AUTOMATION=1`): `attach_magicavoxel_app` pins a process by executable path, id and start time; `set_app_camera` sends the application's console camera commands; `export_native_render` runs the native Final Render and returns only after the PNG has been verified.
- `examples/neon-alley`: a complete scene built through the tools, with its script, palette, scene file and native render.
- `inspectPng` validates PNG structure, bounds and (optionally) checksums without decoding pixels.

- `set_scene_render_object` merges native render dictionaries by type; `set_scene_camera` merges camera slots 0..9. These are low-level saved-file controls, not native renderer automation.

- Tools `get_magicavoxel_info`, `list_magicavoxel_samples`, `list_magicavoxel_palettes`, `list_magicavoxel_shaders`, `list_magicavoxel_ibl` and `load_magicavoxel_sample` (read-only discovery of a MagicaVoxel installation).
- `MAGICAVOXEL_HOME` environment variable; the installation folder is resolved from it or from `MAGICAVOXEL_PATH`.
- Read-only access to the installation's `vox`, `palette`, `shader`, `ibl` and `config` text files by absolute path, without weakening workspace confinement for writes.
- Resources `magicavoxel://install`, `magicavoxel://samples`, `magicavoxel://palettes`, `magicavoxel://shaders`.
- Read-only `config.txt` parser (the `$` folder convention, `workspace` entries, `io_*` export settings).
- Tool-name snapshot test and `docs/baseline.md`.
- `load_vox_models` loads every model of a multi-model or animated `.vox` file and opens it as a scene; `load_vox` gets `modelIndex` (the error for multi-model files now points to both options).
- `flatten_scene` and `extract_scene_model {bake}` apply scene rotations and translations to produce world-space models (`src/sceneBake.ts`); `src/rotation.ts` provides packed `_r` helpers for the 24 orientations.
- Typed codecs for `rOBJ`, `rCAM`, `NOTE`, `IMAP`, `META` and `MATL` (`src/voxChunks.ts`), exposed as `scene.render`; unchanged chunks and unknown keys or chunks are written back byte-for-byte.
- Optional `lenient` parsing for `load_scene`, `load_vox_models` and `load_vox` with `warnings`; strict stays the default.
- `replace_scene_model` accepts `remap: "nearest"` and names the first differing palette index; a palette-less model is read with the default palette.
- Corpus tests against the installed MagicaVoxel samples (`MAGICAVOXEL_HOME` or `MAGICAVOXEL_PATH`, skipped when absent) and synthetic v200 fixtures for CI.
- Palette tools: `import_palette_png`, `import_palette_act`, `import_palette_vox`, `export_palette_png`, `export_palette_act`, `export_palette_vox`, `remap_model_to_palette`, `quantize_model`, `sort_palette`, `find_nearest_color`, `merge_palettes`.
- Voxel format tools: `export_qb`/`import_qb`, `export_xraw`/`import_xraw`, `export_slab6`/`import_slab6`, `export_minecraft_schem`/`import_minecraft_schem` (Sponge v2/v3).
- `export_obj` options `profile` (`basic` or `magica`), `scale`, `axis`, `cw` and `merge`; `export_ply`, `export_stl` and `export_gltf` accept `scale` and `axis` (STL also `merge`).
- `import_obj` solid fill, vertex/material/texture colors, `fit`, `scale` and `axis`, and warnings for open meshes.
- `import_svg` paths, fills, groups, transforms, ellipses, polygons and rounded rectangles, with explicit "unsupported SVG" errors.
- `export_animation_gif` options `quantize`, `dither` and `maxColors`; the result lists `warnings`.
- xs shader tools: `list_xs_shaders`, `read_xs_shader`, `validate_xs_shader`, `write_xs_shader`, `generate_xs_shader_template`, `run_xs_shader`.
- Sandboxed interpreter for a documented GLSL subset of `map(vec3)`; decision record in `docs/xs-shader-evaluation.md`.
- `MAGICAVOXEL_HOME` environment variable (read-only access to the install `shader` folder).

### Changed

- `magicavoxel:samples` and `magicavoxel:palettes` (deprecated, use the new URIs) now read the installation instead of the workspace.
- `open_in_magicavoxel` only opens `.vox` files, starts the application in its installation folder and reports `MAGICAVOXEL_PATH` when unconfigured.
- Scenes are kept parsed in memory with copy-on-write edits and id indexes instead of being decoded on every call; see `docs/scene-performance.md`.
- OBJ, glTF, PLY and STL exports now use proper axis rotations (Y-up for OBJ and glTF, Z-up for STL) instead of swapping Y and Z, which mirrored the model. Output sizes are unchanged.
- `import_obj` size parameters are optional; without them the mesh keeps its size (`scale` 1).
- Output-style tools now include names starting with `write_` (workspace path policy, no undo entry).
- Shader evaluation runs in a worker with a parent-side deadline; protocol pings remain responsive and failed runs roll back.

### Fixed

- `set_scene_material` accepts material id 256.
- Exports read palette colors in the correct byte order: red and blue were swapped in OBJ, PLY, glTF, slices and the legacy schematic.
- Preview, sprite sheet and GIF colors now use the same little-endian RGBA packing as VOX palettes.
- Installation files stay read-only even when they are inside the configured workspace.
- Shader palette() reads the official default palette when a model has no custom palette.
- Inline shader sources no longer hit the generic 4096-character string limit.
- PNG decoding checks dimensions and decompression size before allocation, including interlaced images and palette files.
- Schematic NBT decoding enforces cumulative node, collection and allocation budgets and uses prototype-free dictionaries.
- OBJ texture references are resolved relative to their material library, retaining workspace confinement.

### Tests

- Directory-link (junction) escape tests run on Windows; added nested, in-workspace, dangling and file-link cases.

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

# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `load_vox_models` loads every model of a multi-model or animated `.vox` file and opens it as a scene; `load_vox` gets `modelIndex` (the error for multi-model files now points to both options).
- `flatten_scene` and `extract_scene_model {bake}` apply scene rotations and translations to produce world-space models (`src/sceneBake.ts`); `src/rotation.ts` provides packed `_r` helpers for the 24 orientations.
- Typed codecs for `rOBJ`, `rCAM`, `NOTE`, `IMAP`, `META` and `MATL` (`src/voxChunks.ts`), exposed as `scene.render`; unchanged chunks and unknown keys or chunks are written back byte-for-byte.
- Optional `lenient` parsing for `load_scene`, `load_vox_models` and `load_vox` with `warnings`; strict stays the default.
- `replace_scene_model` accepts `remap: "nearest"` and names the first differing palette index; a palette-less model is read with the default palette.
- Corpus tests against the installed MagicaVoxel samples (`MAGICAVOXEL_HOME` or `MAGICAVOXEL_PATH`, skipped when absent) and synthetic v200 fixtures for CI.

### Changed

- Scenes are kept parsed in memory with copy-on-write edits and id indexes instead of being decoded on every call; see `docs/scene-performance.md`.

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

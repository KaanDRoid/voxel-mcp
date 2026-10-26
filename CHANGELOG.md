# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- xs shader tools: `list_xs_shaders`, `read_xs_shader`, `validate_xs_shader`, `write_xs_shader`, `generate_xs_shader_template`, `run_xs_shader`.
- Sandboxed interpreter for a documented GLSL subset of `map(vec3)`; decision record in `docs/xs-shader-evaluation.md`.
- `MAGICAVOXEL_HOME` environment variable (read-only access to the install `shader` folder).

### Changed

- Output-style tools now include names starting with `write_` (workspace path policy, no undo entry).

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

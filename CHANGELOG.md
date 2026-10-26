# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0]

### Changed

Breaking renames (the package was never published, so no aliases are provided):

- Product name is now `magicvoxel-mcp` for the npm package, the executable (`bin`) and the MCP server name (was `voxel-mcp` / `magica-mcp`).
- Environment variable `VOXEL_MCP_WORKSPACE` -> `MAGICVOXEL_MCP_WORKSPACE`.
- Tool `generate_ankara_block` -> `generate_city_block`.
- Tool `open_in_magica` -> `open_in_magicavoxel`.
- Resource URIs `magica:models`, `magica:vox/{folder}`, `magica:samples`, `magica:palettes` -> `magicavoxel:models`, `magicavoxel:vox/{folder}`, `magicavoxel:samples`, `magicavoxel:palettes`.
- `generate_venue_character` `role`: `konsomatris` -> `hostess`, `musteri` -> `customer`, `garson` -> `waiter`, `asci` -> `cook`, `polis` -> `police_officer`, `mafya` -> `gangster`, `behzatc` -> `detective`.
- `generate_staff` `type`: `barman` -> `bartender`, `konsomatris` -> `hostess`.
- `generate_customer` `type`: `nostalgic` -> `retiree`, `sapkali` -> `farmer`, `behzatc` -> `detective`.
- Prompt-based generation now recognizes English keywords only (`house`, `building`, `home`, `cottage`, `N floors`/`N storeys`, `character`, `humanoid`, `person`, `robot`, `sphere`, `ball`, `globe`).
- All tool descriptions, error messages, comments, tests and documentation are now English and culturally neutral.

### Added

- Language and naming check (`tests/language.test.ts`) that keeps tracked sources ASCII-only and free of locale-specific terms and old names.
- Generic client configuration example `client-config/mcp-client.json`.

## [1.1.0]

- Initial feature-complete release: procedural generators, scene and animation tools, importers and exporters.

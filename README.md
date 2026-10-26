# magicvoxel-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for procedural voxel modeling and MagicaVoxel (`.vox`) file workflows. It runs locally over stdio, keeps models in memory, and reads and writes files only inside a workspace directory you choose.

## Features

- **Models and editing**: primitives (box, sphere, cylinder, cone, pyramid, torus, line), explicit voxels, copy/paste, transforms, boolean operations, morphology (erode, dilate, smooth, hollow, outline), patterns, gradients, noise and symmetry tools.
- **Undo/redo**: `undo` and `redo` cover model edits. A failed edit rolls back automatically. File writes, scenes and animations are not part of undo.
- **VOX files**: strict reader and writer for version 150/200 files with the official default palette. `load_vox` rejects multi-model files instead of silently dropping data: pass `modelIndex` to load one model, or use `load_vox_models` to load every model of a multi-model or animated file (plus a scene that keeps the transforms). Both tools and `load_scene` accept `lenient: true` to recover from duplicate voxels, invalid UTF-8 and malformed render chunks; recovered problems are returned as `warnings`.
- **Scenes**: `create_scene`, `load_scene`, `load_vox_models`, `save_scene`, `flatten_scene`, `get_scene_info`, `list_scenes`, `delete_scene`, `extract_scene_model`, `replace_scene_model`, `set_scene_node`, `set_scene_layer`, `set_scene_material`. Transform, group, shape, layer and material records are preserved and unknown chunks are written back unchanged. Render settings (`rOBJ`, `rCAM`, `NOTE`, `IMAP`, `META`) are parsed into typed fields and written back byte-for-byte when unchanged. Scenes require one shared palette (a model without a palette is read with the default palette; `replace_scene_model` reports the first differing index and accepts `remap: "nearest"`). Transforms are stored rather than baked unless you ask: `flatten_scene` merges all visible objects into one world-space model (hidden layers skipped by default, `splitIntoChunks` for results above 256 per axis) and `extract_scene_model` accepts `bake`. Only the 24 right-angle orientations exist in the format. The pivot rule used for baking (offset from cell `floor(size / 2)`) is unverified against the application. Parsed scenes stay in memory, so repeated calls do not re-decode the file.
- **Preview**: `render_model` returns a palette-colored PNG (`top`, `front`, `side`, `zmax`, `isometric`) directly to the client.
- **Generators**: houses, characters, vehicles, furniture, weapons, structures, creatures, nature, terrain, trees, and city/venue helpers. Output is deterministic for a given seed.
- **Images**: colorized voxelization, silhouettes, depth maps, edge detection and multi-view carving from PNG/JPEG.
- **Animation**: frame registry, deterministic dissolve between frames, sprite sheets, PNG frame folders, and GIF with per-frame timing and loop setting.
- **Export/import**: VOX, OBJ, PLY, STL, glTF 2.0 (embedded), PNG slices, legacy Minecraft `.schematic` (gzip NBT, wool-color approximation); OBJ and basic SVG import.

## Requirements

- Node.js 22 or newer
- MagicaVoxel is optional and only needed for `open_in_magicavoxel`

## Install

```bash
npm ci
npm run build
```

Point your MCP client at `dist/index.js` (see [client-config](client-config/README.md)):

```json
{
  "mcpServers": {
    "magicvoxel-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/magicvoxel-mcp/dist/index.js"],
      "env": { "MAGICVOXEL_MCP_WORKSPACE": "/absolute/path/to/workspace" }
    }
  }
}
```

## Configuration

| Variable | Purpose |
|---|---|
| `MAGICVOXEL_MCP_WORKSPACE` | Directory for all reads and writes. Defaults to the server's working directory. Paths that escape it, including through symlinks, are rejected. |
| `MAGICAVOXEL_PATH` | Absolute path to `MagicaVoxel.exe` or `MagicaVoxel`, enabling `open_in_magicavoxel`. |

## Limits

Models are at most 256 voxels per axis (the VOX limit) and 2,000,000 voxels each. The registry holds up to 64 models and 8,000,000 voxels with a bounded undo history. Input files are limited to 64 MiB; images to 32 MiB and about 4.2 million pixels. Oversized or malformed input returns a tool error.

## Conventions

- X = right, Y = forward, Z = up. Color indexes are 1-255; index 0 is empty.
- Palettes are 256 `uint32` values in little-endian RGBA byte order (`0xAABBGGRR`).
- Scene model IDs are zero-based positions in the scene's model list.

## Example

```text
create_model {sizeX:64, sizeY:64, sizeZ:64}
fill_sphere {id:"1", cx:32, cy:32, cz:32, r:20, i:200}
hollow_model {id:"1", thickness:2}
render_model {id:"1", projection:"isometric"}
save_vox {id:"1", path:"out/hollow_sphere.vox"}
```

## Development

```bash
npm run typecheck   # strict type check of sources and tests
npm test            # build, then run all tests, including real stdio MCP sessions
npm run check       # typecheck, tests and npm audit
```

## Known limitations

- OBJ import samples surfaces (no solid fill); SVG import supports unstyled `<rect>` and `<circle>` only.
- GIF frames are limited to 255 opaque colors with on/off transparency.
- MagicaVoxel is launched with a file but is not remotely controlled.

## License

ISC

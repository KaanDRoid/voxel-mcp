# magicvoxel-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for procedural voxel modeling and MagicaVoxel (`.vox`) file workflows. It runs locally over stdio, keeps models in memory, and writes files only inside a workspace directory you choose. A configured MagicaVoxel installation is accessible through restricted read-only roots.

## Features

- **Models and editing**: primitives (box, sphere, cylinder, cone, pyramid, torus, line), explicit voxels, copy/paste, transforms, boolean operations, morphology (erode, dilate, smooth, hollow, outline), patterns, gradients, noise and symmetry tools.
- **Undo/redo**: `undo` and `redo` cover model edits. A failed edit rolls back automatically. File writes, scenes and animations are not part of undo.
- **VOX files**: strict reader and writer for version 150/200 files with the official default palette. `load_vox` rejects multi-model files instead of silently dropping data: pass `modelIndex` to load one model, or use `load_vox_models` to load every model of a multi-model or animated file (plus a scene that keeps the transforms). Both tools and `load_scene` accept `lenient: true` to recover from duplicate voxels, invalid UTF-8 and malformed render chunks; recovered problems are returned as `warnings`.
- **Scenes**: `create_scene`, `load_scene`, `load_vox_models`, `save_scene`, `flatten_scene`, `get_scene_info`, `list_scenes`, `delete_scene`, `extract_scene_model`, `replace_scene_model`, `set_scene_node`, `set_scene_layer`, `set_scene_material`. Transform, group, shape, layer and material records are preserved and unknown chunks are written back unchanged. Render settings (`rOBJ`, `rCAM`, `NOTE`, `IMAP`, `META`) are parsed into typed fields and written back byte-for-byte when unchanged. Scenes require one shared palette (a model without a palette is read with the default palette; `replace_scene_model` reports the first differing index and accepts `remap: "nearest"`). Transforms are stored rather than baked unless you ask: `flatten_scene` merges all visible objects into one world-space model (hidden layers skipped by default, `splitIntoChunks` for results above 256 per axis) and `extract_scene_model` accepts `bake`. Only the 24 right-angle orientations exist in the format. The pivot rule used for baking (offset from cell `floor(size / 2)`) is unverified against the application. Parsed scenes stay in memory, so repeated calls do not re-decode the file.

- **MagicaVoxel installation (read-only)**: `get_magicavoxel_info`, `list_magicavoxel_samples`, `list_magicavoxel_palettes`, `list_magicavoxel_shaders`, `list_magicavoxel_ibl` and `load_magicavoxel_sample` discover the sample models, palettes, xs shaders, environment maps and `config.txt` of a MagicaVoxel folder. The folder is never written to, and nothing is started.
- **Preview**: `render_model` returns a palette-colored PNG (`top`, `front`, `side`, `zmax`, `isometric`) directly to the client.
- **Generators**: houses, characters, vehicles, furniture, weapons, structures, creatures, nature, terrain, trees, and city/venue helpers. Output is deterministic for a given seed.
- **Images**: colorized voxelization, silhouettes, depth maps, edge detection and multi-view carving from PNG/JPEG.
- **Animation**: frame registry, deterministic dissolve between frames, sprite sheets, PNG frame folders, and GIF with per-frame timing and loop setting.
- **Palettes**: load and save MagicaVoxel palette PNGs (`import_palette_png`, `export_palette_png`), Adobe `.act` and palette-only VOX files; `remap_model_to_palette`, `quantize_model`, `sort_palette`, `find_nearest_color` and `merge_palettes` work in CIE Lab and report the color error.
- **Export/import**: VOX, OBJ (basic or MagicaVoxel profile with `.mtl` and palette texture), PLY, STL, glTF 2.0 (embedded), PNG slices, Qubicle `.qb`, XRAW, Slab6 VOX, Sponge `.schem` (v2/v3) and legacy Minecraft `.schematic`; OBJ import with solid fill and colors, SVG import with paths, fills and transforms.

- **xs shaders**: `list_xs_shaders`, `read_xs_shader`, `validate_xs_shader`, `write_xs_shader` (workspace only), `generate_xs_shader_template` and `run_xs_shader`. Shaders are read from the workspace or from the `shader` folder of the MagicaVoxel install (`MAGICAVOXEL_HOME`, or the folder of `MAGICAVOXEL_PATH`); the install folder is never written. `run_xs_shader` uses a built-in sandboxed interpreter for a documented GLSL subset (no code is evaluated by the JavaScript engine) and is undoable. See `docs/xs-shader-evaluation.md`.

## Requirements

- Node.js 22 or newer
- MagicaVoxel is optional: it is needed for `open_in_magicavoxel` and for the installation discovery tools

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
| `MAGICAVOXEL_PATH` | Absolute path to `MagicaVoxel.exe` or `MagicaVoxel`, enabling `open_in_magicavoxel` and installation discovery. Takes precedence over `MAGICAVOXEL_HOME`. |
| `MAGICAVOXEL_HOME` | The MagicaVoxel installation folder (the one containing the executable, `config`, `vox`, `palette`, `shader` and `ibl`). Enables the discovery tools and, when `MAGICAVOXEL_PATH` is unset, `open_in_magicavoxel`. |

When an installation is configured, its `vox`, `palette`, `shader` and `ibl` folders and its `config` text files become readable by absolute path (only `.vox`, `.png`, `.txt` and `.hdr` files respectively). Executables, the `cache` folder and everything else in the installation stay unreadable, and nothing in it can be written, even if it is inside the selected workspace; all writes remain confined to the workspace.

`open_in_magicavoxel` only opens `.vox` files and starts the application with the installation folder as its working directory.

### Resources

`magicavoxel://install`, `magicavoxel://samples`, `magicavoxel://palettes` and `magicavoxel://shaders` describe the installation. `magicavoxel:samples` and `magicavoxel:palettes` are deprecated aliases that return plain file-name lists from the installation (previously they looked in the workspace). `magicavoxel:models` and `magicavoxel:vox/{folder}` are unchanged.


## Limits

Models are at most 256 voxels per axis (the VOX limit) and 2,000,000 voxels each. The registry holds up to 64 models and 8,000,000 voxels with a bounded undo history. Input files are limited to 64 MiB; images to 32 MiB and about 4.2 million pixels. Oversized or malformed input returns a tool error.

xs shader runs are limited to 200,000 interpreter steps per voxel, 4,096 iterations per loop, shader sources of 64 KiB and a wall-clock limit (default 20 s, at most 120 s). Evaluation runs in a worker thread so it cannot block protocol pings, and timeout leaves the model unchanged. Dense shaders with long loops (for example the shipped Mandelbulb) take about a minute at 128^3 and are best run on smaller volumes.

Palette PNG imports require exactly 256 pixels (for example 256x1 or 16x16).
PNG dimensions and inflated scanline sizes are checked before decoding, including
interlaced files. Schematic NBT input is limited to 64 MiB after decompression,
100,000 parsed nodes and a 64 MiB estimated allocation budget.

## Conventions

- X = right, Y = forward, Z = up. Color indexes are 1-255; index 0 is empty.
- Palettes are 256 `uint32` values in little-endian RGBA byte order (`0xAABBGGRR`).
- Scene model IDs are zero-based positions in the scene's model list.
- Scene material ids are 1..256, as found in files written by the application. How id 256 maps to a palette slot is unverified.

## Format notes

- Mesh exports (`export_obj`, `export_ply`, `export_stl`, `export_gltf`) take `scale` (output units per voxel) and `axis`. An axis is three signed letters: `XYZ` keeps Z up (STL default), `XZ-Y` is Y up (OBJ and glTF default; a rotation, so faces keep their winding). `export_obj` with `profile: "magica"` uses the `io_obj` defaults of MagicaVoxel (`scale` 0.1, merged faces) and writes `<name>.mtl` and `<name>.png` beside the OBJ.
- Palette PNG, ACT and palette-VOX files store slot k for voxel index k+1 and slot 255 for index 0, like MagicaVoxel's own `palette/pal*.png`. The older `load_palette_from_png` / `save_palette_to_png` tools map pixel k to index k instead; prefer the `*_palette_png` tools for MagicaVoxel palettes.
- `import_obj` reads `.mtl` files and PNG textures from inside the workspace only. Closed meshes are filled with the voxels whose centers are inside; faces exactly on voxel boundaries are handled by that fill. Open meshes keep only their surface and report a warning.
- Qubicle, XRAW, Slab6 and `.schem` layouts follow public format descriptions and are covered by byte-level tests; the axis mapping to the original applications is unverified. Slab6 VOX is the Slab6/SLABSPRI grid format, not the MagicaVoxel container.

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

- OBJ import fills closed meshes only; thin features narrower than a voxel can vanish in solid mode (use `fill: "surface"`).
- SVG import is fill-only: strokes, text, gradients, CSS classes, clipping, opacity, `use` and elliptical arcs raise an "unsupported SVG" error.
- GIF frames are limited to 255 opaque colors with on/off transparency; use `quantize: "median-cut"` (and optionally `dither: "floyd"`) to reduce colors instead of failing.
- OBJ, PLY, MC-style and other MagicaVoxel exports have not been compared against the application's own output (parity unverified).
- MagicaVoxel is launched with a file but is not remotely controlled.

## License

ISC

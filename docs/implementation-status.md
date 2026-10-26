# Implementation status

This document distinguishes implemented server features from compatibility that
still needs a supervised check in the MagicaVoxel application. Passing a binary
round-trip test is not evidence of live application control or complete parity.

## Integrated work

| Area | Roadmap tasks | Status |
| --- | --- | --- |
| Tool catalog baseline and naming snapshot | P0-2 | Implemented; the current snapshot contains 153 unique tools. |
| Application launch validation | P0-3 | Mock-spawn tests pass; only .vox files are accepted and the working directory is the installation folder. The real application has not been launched. |
| Material id range | P0-5 | Material ids 1..256 are accepted. The interpretation of id 256 remains unverified in the application. |
| Installation discovery, configuration and read-only roots | P1-1, P1-2, P1-3, P1-4 | Implemented. The installation is protected even if it is inside the workspace. |
| Corpus and typed VOX chunks | P0-4, P2-1, P2-2 | All 15 installed sample files decode strictly and round-trip byte-for-byte. Synthetic fixtures cover CI without redistributing application assets. |
| Multi-model files, rotations, scene baking and cache | P2-5, P2-6, P2-7, P2-8 | Implemented. The baking pivot convention still requires an application-level comparison. |
| Lenient loading and scene palette remapping | P2-9, P2-10 | Implemented with warnings; strict remains the default. |
| Palette file formats and color operations | P6-1, P6-2, P6-3 | Implemented: PNG, ACT, palette VOX, quantization, sorting, remapping and GIF dithering. ACT and palette-VOX application parity is unverified. |
| Mesh import/export improvements | P7-1, P7-2, P7-6, P7-7 | Implemented with documented subsets; exact MagicaVoxel output parity is unverified. |
| Voxel formats | P7-3 | Partial: QB, XRAW and Slab6 VOX implemented. Build-engine KVX and other RAW variants are not implemented. |
| Sponge schematics | P7-5 | Sponge v2/v3 export and import implemented; legacy schematic export remains available. |
| XS parsing, validation and evaluation | P8-1, P8-2, P8-3, P8-4 | Parser, workspace writer, templates and bounded evaluator implemented. No installation writer. Evaluation uses a worker thread with a parent-side deadline. This is not a complete GLSL implementation. |
| Windows directory-link protection | P11-10 | Junction tests run on Windows. File-symlink tests skip only when the OS denies creating them. |

## Integration corrections

- Unified renderer colors with the VOX little-endian RGBA convention.
- Protected the entire application installation from writes, including when a
  broad workspace contains it. Only explicitly allowlisted asset roots are readable.
- Moved shader execution off the protocol thread and added a forced deadline.
- Fixed palette() for models with an implicit default palette and aligned inline
  source limits with the shader schemas.
- Reconciled parallel registrations, catalog coverage and the tool-name snapshot.
- Bounded palette/image/texture PNG decompression before image decoding.
- Added NBT node/allocation budgets and prototype-free dictionaries.
- Corrected texture paths for material libraries in nested directories.

## Verification commands

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
MAGICAVOXEL_HOME=/path/to/MagicaVoxel npm test
npm audit
npm pack --dry-run
```

The installed-corpus run is read-only. Do not commit the application's bundled
models, palettes, shaders or environment images.

## Still pending

- Supervised application tests: file launch, scene pivot, output parity and any
  feasible automation interface. No supported remote-control API is assumed.
- Full scene/object/layer CRUD and scene undo/redo (phase 3).
- Typed material, render and camera tools (phase 4).
- Native VOX animation editing and the animation-to-scene bridge (phase 5).
- Installation-palette convenience tools and additional export parity work.
- Preview lighting, scene rendering and turntable export (phase 10).
- Declarative file/effect metadata, structured outputs, cancellation and toolsets
  (phase 11); versioned release and package publication (phase 12).

Do not describe the project as complete for every MagicaVoxel workflow while
these items remain pending.

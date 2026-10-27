# Implementation status

This document distinguishes implemented server features from compatibility that
still needs a supervised check in the MagicaVoxel application. Passing a binary
round-trip test is not evidence of live application control or complete parity.

## Integrated work

| Area | Roadmap tasks | Status |
| --- | --- | --- |
| Tool catalog baseline and naming snapshot | P0-2 | Implemented; the current snapshot contains 177 unique tools. |
| Application launch validation | P0-3 | Mock-spawn tests pass; only .vox files are accepted and the working directory is the installation folder. A generated scene has also been opened and rendered in a separate copy of the application; the original install was unchanged. |
| Live application control (Windows, opt-in) | P10 | Implemented through the application's own console and Final Render dialog. Process identity and the finished PNG are verified; camera commands are verified only as submitted. Calibrated on 0.99.7.2: native Photo, Turntable and Anim PNG output is verified per file. Camera readback decodes a native Save As snapshot with explicit slot/active-filename side effects. |
| Low-level render and camera setters | P4 | Native rOBJ settings and rCAM slots 0..9 can be merged and saved; this is not renderer automation or a physical-light API. |
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

## Scene and protocol workflows

| Area | Status |
| --- | --- |
| Scene placement editing and history | Add, duplicate, remove and reparent objects; explicit layer reassignment on deletion; independent bounded scene undo/redo. Existing setters participate. Local transforms are preserved when reparenting. Arbitrary group construction and world-transform-preserving reparenting are not exposed. |
| Typed saved settings | Validated material properties, studio/daylight/night metadata presets and native camera vectors. These edit file metadata, not a physical-light API or live viewport. |
| Native animation | Transform and shape keys by explicit native frame index, inspection/removal, and conversion from the actual frame registry or explicit model IDs. Timing quantization is reported; the bridge uses the native world/group/object/shape hierarchy and shape _loop flag. FPS/duration remain custom metadata; wall-clock native timing is not guaranteed. |
| Baker timeline and graph bounds | Sparse/unsorted keys use a consistent hold-last selection policy, with earliest-key fallback. Expanded shared graphs are bounded before traversal. Native pivot parity remains unverified. |
| Installed palettes | Explicit named palette loading and recolor/nearest application, confined to read-only installation roots. Model edits support registry undo. |
| Tool policy and subsets | Explicit policy for every tool, effect metadata, read-only annotations and opt-in tool groups; core tools always retained. Resources/prompts are not group-filtered. |
| Structured results | Successful JSON objects are mirrored into structured content; arrays use an items envelope. Existing text/images and errors are preserved. No universal output schema is claimed. |
| Cooperative cancellation | Cancelled queued calls never execute; active shader workers terminate before rollback; helper cancellation and render polling stop safely. Synchronous tools are not preemptible and native rendering may continue. |
| Helper failure handling | Bounded termination retries; if helper closure cannot be confirmed, all tool execution is permanently disabled with an actionable error until the helper is stopped and the server restarted. |
| Allocation safety | Preflight counts and estimated peak allocations before model copies, graph expansion and scene decoding. Retained scene/history budget remains 64 MiB; independent estimated transient budget is 256 MiB. Neon Alley load/create/edit/save has a regression test. |

See [Scene workflows](scene-workflows.md), [Native workflows](native-workflows.md), [Format compatibility](format-compatibility.md) and [Tool selection](toolsets.md).

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

- Further supervised application tests: general scene pivot/rotation rules, output parity and any
  feasible automation interface. No supported remote-control API is assumed.
- Arbitrary group creation/deletion workflows and world-transform-preserving reparenting; placement editing and bounded scene undo/redo are implemented.
- Native application verification of typed preset appearance and animation playback/timing.
- Additional export parity work and unimplemented KVX/RAW variants.
- Live control on other operating systems, passive camera-memory polling, general native interpolation/timing verification and configurable sequence resolution beyond the current native render buffer. Native snapshot camera readback and Turntable/Anim final-render exports are implemented.
- Stronger cancellation/preemption for synchronous operations and complete transactional rollback of non-model state.
- npm publication is deferred until an owner account is available; local installation does not require publication.

Do not describe the project as complete for every MagicaVoxel workflow while
these items remain pending.

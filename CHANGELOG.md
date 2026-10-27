# Changelog

## [Unreleased]

## [1.0.0] - 2026-10-27

First stable release. Earlier development version labels are consolidated into
1.0.0; commit history is retained. GitHub/local installation is supported without
an npm account. This release does not publish the package to the npm registry.

### Modeling and scenes

- Bounded voxel modeling, primitives, procedural generators, image conversion,
  morphology, analysis, palette tools, previews and transactional model undo/redo.
- VOX 150/200 scene loading/saving, multiple models, layers, node transforms,
  materials, render/camera metadata and preservation of untouched unknown chunks.
- Scene placement editing, independent bounded scene history, model replacement,
  native key editing, lighting metadata presets and saved-camera poses.
- Frame animations, per-frame durations, GIF/spritesheets and compiled native
  shape animations. Compiled mode copies every quantized tick, including the last
  source frame's hold, and writes native META _anim_range. Sparse mode is explicit.
- Native range inspection/editing with set_scene_animation_range (0..360).

### Windows application workflows

- Opt-in attachment pins executable path, PID and start time; guarded input uses
  calibrated MagicaVoxel 0.99.7.2 controls and refuses unexpected existing dialogs.
- Camera commands, native Save As camera snapshots and verified Photo, Turntable
  and Anim PNG exports. Camera snapshots disclose slot/active-filename changes.
- set_app_animation_timing submits bounded native range/frame/speed controls.
  Speed is the native nonlinear 0..100 slider, not a fabricated FPS setting.
- Animation export normalizes the active playback range before render, preventing
  an old range from silently clamping requested frames. Native 0..2 rendering was
  checked as red/blue/blue for unequal-duration compiled source frames.

### Asset interchange

- Mesh OBJ/MTL/textures, PLY, STL and embedded glTF; SVG and solid/color OBJ import.
- QB raw/RLE, XRAW indexed8/direct RGBA8, explicit headerless RAW rgba8/rgb8/indexed8,
  Slab6 VOX, bounded Build-engine KVX and Sponge schem v2/v3; legacy schematic export.
- Native asymmetric XRAW/QB/Slab6/OBJ/PLY fixtures verify occupancy, colors, axes,
  centered pivots, surface geometry and six-bit palette conversion where applicable.
- Explicit format-loss warnings, RAW layout metadata and rejection of ambiguous or
  unsupported encodings rather than heuristic dialect guessing.

### Runtime and safety

- Explicit tool policies, selectable toolsets, structured JSON results, real stdio
  integration tests and Windows/Linux CI across supported Node LTS lines.
- Read-only installation discovery/assets; workspace and realpath confinement,
  including Windows junctions and installation protection within broad workspaces.
- Bounded PNG inflation/palettes, NBT decoding, scene copies/history/graph traversal
  and RAW/KVX/XRAW voxel materialization; prototype-free untrusted dictionaries.
- Bounded XS subset evaluator in a worker, cancellation/termination handshakes,
  serialized live operations and fail-closed handling of unconfirmed helper exit.
- Production package excludes developer tests/source while including compiled
  workers, configuration examples and documentation.

### Scope

Windows live control only; macOS/Linux live control is out of scope. Cross-platform
file/model tools remain available. No universal byte-identical conversion, native
hard-real-time FPS guarantee, passive camera-memory polling or complete GLSL is
claimed. See the format and native-workflow compatibility documents.

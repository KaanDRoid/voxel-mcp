# Stable scope and verification

Version 1.0.0 targets cross-platform file/model workflows and opt-in live control on
Windows with MagicaVoxel 0.99.7.2. macOS/Linux live control is explicitly out of scope.
A stable release promises these contracts, not every possible MagicaVoxel workflow.

| Area | Implemented contract |
| --- | --- |
| Modeling | Voxel editing, generators, morphology, palettes, images, previews and transactional model undo/redo. |
| VOX scenes | Multi-model 150/200, graph/layers/materials, render/camera dictionaries, unknown chunks on unchanged round-trips, placement editing and independent bounded scene undo/redo. |
| Animation | Frame registry, duration/loop controls, GIF/images, native keys/ranges, compiled per-tick models with final holds, explicit sparse mode. Native range and unequal-duration compiled output verified in the application. |
| Windows live control | Pinned identity, guarded console input, range/frame/nonlinear speed, native saved-camera readback and verified Photo/Turntable/Anim PNGs. |
| Formats | QB, indexed/direct XRAW, explicit RAW, Slab6, KVX, palette formats, meshes and schematics within documented subsets and budgets. Native asymmetric fixtures verify XRAW/QB/Slab6/OBJ/PLY. |
| XS | Read-only installed shader discovery, workspace templates/writer and bounded GLSL subset in a worker; not full GLSL. |
| Runtime | Explicit per-tool effects/toolsets, structured JSON, real stdio integration, cooperative cancellation, bounded scene/history/decoder allocations and fail-closed helper termination. |
| Installation | Local/GitHub use requires Node, not an npm account. Bundled application assets are read-only and are not redistributed. |

## Verified native behavior

- Native generated-scene Save As and decoded camera slots, Photo PNG output,
  Turntable/Anim sequences, checksummed files and actual common dimensions.
- Asymmetric four-color 3x4x5 exports: native XRAW/QB colored coordinates, exact
  Slab6 bytes including palette truncation/YZ conversion, OBJ/PLY colored surfaces.
- Native saved META confirms changed range 1..2. A compiled 100ms/200ms clip at 10
  source ticks/second produces three actual 960x800 native frames: red, blue, blue.
- Native speed is not FPS or milliseconds per frame: the 0..100 native knob is
  exposed as speed, not converted through an invented formula.

## Explicit boundaries

- File formats have intrinsic losses: six-bit RGB, missing implicit KVX interior
  colors, surface-only meshes and Minecraft block mapping. Consult the matrix.
- Source FPS/durations describe quantized ticks; VOX has no standardized saved FPS
  field here. Native playback is not a hard-real-time clock. Arbitrary imported
  interpolation and scene pivot/rotation baking are not universally certified.
- UI actions require the documented Render-mode/layout/focus preconditions and
  stopped playback. Commands are reported as submitted, not silently confirmed.
- Native jobs may continue after cancellation/timeouts. Files/non-model state do
  not have universal rollback; synchronous handlers are not preemptible.
- No passive camera-memory polling or arbitrary sequence resolution setter is
  claimed; camera snapshots have explicit side effects and sequences use the
  actual native render buffer.
- Arbitrary group construction and world-transform-preserving reparenting are not
  exposed; existing placement editing preserves local transforms.
- npm registry publication is separate and has not been performed.

## Reproduce checks

```sh
npm ci --ignore-scripts
npm run check
MAGICAVOXEL_HOME=/path/to/MagicaVoxel npm test
npm pack --dry-run
```

Installed-corpus tests are read-only. The optional installation corpus is not
shipped; independent synthetic and self-authored native fixtures run in CI.
See [formats](format-compatibility.md), [native workflows](native-workflows.md),
[scene workflows](scene-workflows.md) and [tool selection](toolsets.md).

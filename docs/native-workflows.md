# Native camera snapshots and image sequences

These are opt-in Windows UI workflows, calibrated on MagicaVoxel 0.99.7.2.
They are not a remote-control protocol. Enable `MAGICVOXEL_MCP_UI_AUTOMATION=1`,
configure `MAGICAVOXEL_PATH`, open the scene, switch to **Render** mode and keep
its window fully on screen. Close any existing dialogs before attaching. Do not
use the mouse or keyboard during input delivery. Use a separate application copy
for experiments; the server's installation write policy cannot prevent the
external application from writing its own configuration or cache.

## Camera readback

```text
attach_magicavoxel_app {pid:1234}
set_app_camera {focus:true, rx:-24, ry:-35}
export_app_camera_snapshot {path:"out/camera-snapshot.vox", cameraId:9}
```

`set_app_camera` reports submitted commands, not a confirmed pose. The snapshot
tool runs `set cam_slot 9`, `cam save`, then the native **Save Project As** action.
It waits for a fresh, stable, bounded VOX file, decodes it, and returns that
slot's actual `rCAM` dictionary. `_focus` and `_angle` are validated three-number
vectors; `_radius` and `_fov` are finite native values. Raw saved angles are not
necessarily the same coordinate convention as `cam rx/ry/rz` arguments.

**This is not a passive query.** It changes the selected slot, replaces that
in-memory saved-camera slot, and changes the active project's filename to the
snapshot. Use a new path; existing files are refused. The previous file is not
saved over by this workflow. There is no supported continuous camera-memory
polling API and no automatic restoration of the original active filename.

## Native Final Render sequences

```text
export_native_sequence {path:"out/orbit.png", kind:"turntable", frames:24, angle:360, blur:0}
export_native_sequence {path:"out/clip.png", kind:"animation", start:2, end:3}
```

This selects the actual Turntable or Anim panel and invokes its native Render
button. It does not loop over Photo calls and does not use the palette preview.
The currently opened native scene must contain the intended animation.

- Turntable: 1..120 frames, angle 0..360, blur 0..100; defaults are 12/360/0.
- Animation: inclusive start/end in 0..120, at most 120 outputs. Turntable-only
  parameters cannot be combined with animation or vice versa.
- Naming: `orbit (0000).png`, `orbit (0001).png`, etc. An animation starting at
  frame 2 produces `clip (0002).png` and `clip (0003).png`, not zero-based suffixes.
- **Resolution is the current native render buffer size.** Photo width/height do
  not configure sequence resolution. The tool returns the actual common width
  and height, and does not accept pretend sequence-size parameters.
- Every expected frame must be new, regular, confined to the workspace, within
  its byte budget, stable, structurally valid PNG with valid chunk CRCs, and have
  matching dimensions. Limits: 64 MiB per frame, 16 million pixels per frame,
  256 MiB per sequence. CRC validation is not full pixel decoding.
- Any existing expected frame refuses the operation. The default observation
  timeout is 600 seconds, configurable from 30 to 3600 seconds.
- Native jobs can continue after timeout or cancellation. Check the output
  directory and the application before retrying with another name. Stable files
  and modification times are observations, not cryptographic writer attribution
  or a renderer-completion handshake.

`export_native_render` explicitly switches back to Photo mode, so it still works
immediately after a sequence. Its `imageWidth`/`imageHeight` control Photo only.

## Animation scene compatibility

`animation_to_scene` creates the native world transform, group, object transform
and shape hierarchy, with one copied model per source frame and native `_f`
keys. The shape also stores `_loop`; FPS and duration metadata remain custom,
so wall-clock playback timing is not guaranteed. Inspect returned scene nodes
rather than hard-coding node IDs from earlier versions. Sparse-key interpolation
and arbitrary imported graph shapes still need separate native comparisons.

## Supervised verification

On Windows with a scratch copy of 0.99.7.2:

- A 316,352-voxel generated scene was saved natively and camera slot 9 decoded:
  `_focus = 0 0 56`, `_angle = -20 323 0`, `_radius = 253.512`, `_fov = 45`.
- Two native turntable frames and two native animation frames at timeline 2..3
  were verified at 960x800, including every PNG chunk CRC and stable file size.
- A four-model, shared-palette color-toggle fixture rendered different red and
  blue native animation frames at 2..3. A static scene alone was not treated as
  proof that animation playback changes the image.
- A 64x48 native Photo export succeeded immediately after animation rendering.

These checks demonstrate these workflows, not every renderer setting, every
animation graph or all-platform compatibility. Automated filesystem-verifier
regressions run independently of the Windows input adapter on every CI host.

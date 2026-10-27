# Tool selection and result metadata

## Reduce the tool catalog

By default all tools are advertised. Set `MAGICVOXEL_MCP_TOOLSETS` to a
comma-separated list to advertise only the groups you need, for example:

```json
{
  "env": {
    "MAGICVOXEL_MCP_WORKSPACE": "/absolute/path/to/workspace",
    "MAGICVOXEL_MCP_TOOLSETS": "modeling,scene,palette"
  }
}
```

Merge these environment values into the server's existing client configuration;
this fragment is not a complete server launch configuration. Restart the server
when changing the selection.

| Group | Contents |
| --- | --- |
| `core` | Model lifecycle, load/save VOX, preview, analysis, basic installation information and sample loading. Always included. |
| `modeling` | Voxel edits, transforms, primitives, generators, morphology, clipboard and image conversions. |
| `scene` | Scene loading/saving, graph edits, layers, materials, saved cameras, native keyframes and animation-to-scene conversion. |
| `animation` | Separate frame registry, duration/loop controls, dissolve interpolation and image/GIF exports. |
| `palette` | Palette loading/writing, quantization, remapping, color helpers and installed-palette selection. |
| `formats` | Mesh, voxel-grid and Minecraft format import/export. |
| `shaders` | XS source inspection, validation, templates, writing and bounded evaluation. |
| `app` | Application launch/attachment, live camera commands, explicit native camera snapshots and native Photo/Turntable/Anim final renders. |

Blank or unset enables all groups. Names are lowercase and case-sensitive;
unknown groups or empty comma-separated entries are startup errors. A selected
group does not silently enable another optional group. For example, include both
`scene` and `animation` to create frame-registry animations and convert them into
scenes. A scene-only configuration can convert explicit model IDs without the
frame-registry tools. Add `modeling` to obtain primitive/voxel-edit tools.

Tool selection reduces discovery and callable tools. It is not a sandbox or an
authorization mechanism: existing workspace confinement and UI opt-in checks
remain essential. Installation resources and prompts are not filtered by toolset.

## Metadata

Every registered tool is classified by `src/toolPolicy.ts`, with conservative
failure on a new unclassified tool. Discovery includes:

- Standard `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations.
- `_meta["magicvoxel/toolset"]`: the tool's group.
- `_meta["magicvoxel/effects"]`: possible effects such as `file-read`,
  `file-write`, `model-mutation`, `scene-mutation`, `animation-mutation`,
  `clipboard-write`, `session-mutation`, `app-launch` and `app-input`.

Effects describe what a tool may do, not what every invocation necessarily does.
Reading a file alone is read-only; changing the clipboard is not. An annotation
is a client hint, never a substitute for safety checks or user approval.

## Structured results

Existing text and image content blocks remain available. A successful result
containing one unambiguous JSON object text payload additionally exposes that
object as `structuredContent`. A JSON array uses `{ "items": [...] }` so the
structured result is an object. Plain text, JSON primitives, errors, ambiguous
multiple text blocks and already-structured results are left unchanged.

No universal `outputSchema` is advertised: output shape varies by tool, and
adding structured content does not imply stronger schema guarantees.

## Cancellation

MCP request cancellation is cooperative. A queued call cancelled before its turn
is skipped before it prepares output paths or mutates state. An active XS worker
is terminated and awaited before its model transaction rolls back and the queue
moves on. Subsequent tools cannot interleave with that unfinished operation.

Live automation cancellation stops the helper, not MagicaVoxel. The server waits
for helper closure before releasing the queue and also checks cancellation during
render-file polling. A render already started in the native application may
continue and write its file later; already-delivered keystrokes cannot be undone.
If helper closure cannot be confirmed after bounded termination attempts, the
server disables all tools instead of silently hanging or permitting concurrent
input. Stop the reported helper process and restart the MCP server; late closure
does not clear this safety latch.

Forced helper termination does not send synthetic modifier-release input to
another window, so a key or mouse button held at that instant may remain logically
pressed. Do not use the computer while live automation runs.

Synchronous CPU-bound operations are not preemptible mid-execution. Cancellation
is checked when the event loop can process it, not on every voxel. It does not
undo already-written files or committed non-model state. This is not a general
transactional cancellation guarantee for every tool.

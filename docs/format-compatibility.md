# Format compatibility

"Supported" means the documented subset can be read or written. It does not
mean byte-identical output to MagicaVoxel, a lossless conversion of all scene
features, or validation by every other application's importer.

| Format/workflow | Preserved or represented | Deliberate limits / verification |
| --- | --- | --- |
| MagicaVoxel VOX 150/200 scenes | Voxel indices, shared palette, multiple models, native node/layer/material records, keyframes and render metadata; unknown chunks preserved on unedited round-trips | Installed sample corpus strictly decodes and round-trips byte-for-byte. Native generated-scene saving, camera snapshot decoding and a four-model shape-animation render are supervised checks. General pivot/rotation baking, interpolation and every native metadata meaning are not certified. |
| Single-model VOX | One selected model and its palette | Multi-model files require an explicit model index or scene/multi-model loading; a single-model export does not preserve a scene graph. |
| Palette PNG | All 256 RGBA entries in MagicaVoxel slot order | 256 pixels required; installed palette PNGs are read in optional corpus tests. These files are palettes, not voxel renders. |
| ACT | 256 RGB slots; supported count/transparency trailer on import | 768-byte RGB export. Alpha is not a general ACT RGB feature. Byte-level and round-trip tests; native application interchange is not certified. |
| Palette VOX | Palette RGBA chunk | Palette-only container, not a full scene. Native palette import parity remains unverified. |
| OBJ basic / Magica profile | Exposed surfaces, axis/scale settings; profile writes MTL plus palette PNG | Polygon ordering/merging and material dictionaries are not promised byte-identical to MagicaVoxel. OBJ does not retain voxel interiors, native scene animation, lights or cameras. Import voxelization is resolution-dependent. |
| PLY / STL / glTF | Surface geometry with explicit axis/scale; PLY colors and glTF palette materials | STL has no palette/material representation here. These exporters do not carry native VOX keyframes or renderer settings. Geometry, winding, units and buffer layout are independently tested, not native-output byte parity. |
| Qubicle QB | Supported raw/RLE voxel matrices, color order and orientation conversion | Documented supported subset with independent byte fixtures and raw/RLE round-trips; not the complete Qubicle project format or all native importer behavior. |
| XRAW | Supported indexed and direct-color raw voxel layouts | Header, x-fastest order, palette and malformed-input tests. Other RAW dialects are not aliases of XRAW. |
| Slab6 VOX | Grid occupancy and 6-bit palette | Not a MagicaVoxel VOX file despite the same extension. Palette precision loss is inherent and tested. Build-engine KVX is not implemented. |
| Sponge schem v2/v3 | Block grid, palette/varints, axis conversion, supported block color mapping | Minecraft block mapping cannot preserve arbitrary voxel color/material semantics. Legacy schematic export is separate. Tests validate NBT bytes and import/export semantics. |
| PNG/GIF/spritesheet | Rendered palette images and explicit frame data | These are raster previews, not native path-traced renders. GIF has at most 255 opaque colors plus binary transparency; optional quantization is lossy. |
| Native Photo/Turntable/Anim | The application's own final-render PNG output | Opt-in calibrated Windows workflow, not an independent renderer. See [Native workflows](native-workflows.md) for dimensions, naming, bounds and cancellation limits. |

## Choose a preservation target

- Keep `.vox` scenes as the editable master when layers, materials, camera slots
  and native keyframes matter. Do not use a mesh or schematic as a scene backup.
- Export meshes for surface-based tools and choose explicit axis/scale settings.
- Use ACT only when RGB palette slots are enough; prefer PNG or palette VOX when
  alpha matters.
- Use the native export tools for native lighting/reflections rather than
  treating `render_model` as an interchangeable renderer.

Byte-for-byte parity is intentionally not a universal goal: different polygon
ordering can describe the same surface, and some destination formats cannot
represent the source's features at all. Additional native import/export
comparisons and unimplemented KVX/RAW variants remain separate work, not hidden
behind a successful reader/writer round-trip.

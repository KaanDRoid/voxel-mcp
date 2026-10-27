# Format compatibility

Stable support means these documented subsets, not byte-identical output from
every application. Keep VOX scenes as editable masters: surface meshes, six-bit
palettes and Minecraft block mappings cannot preserve every VOX feature.

| Format | Preservation and verification | Limits |
| --- | --- | --- |
| VOX 150/200 | Multiple models, palette, nodes/layers/materials, keys, render metadata; installed samples strictly round-trip byte-for-byte | Unknown chunks survive unchanged round-trips. Generated scenes, cameras, ranges and compiled ticks verified in Windows 0.99.7.2; not every native interpolation/metadata meaning is certified. |
| Single-model VOX | Selected model and palette | Scene graph is not retained. |
| Palette PNG/VOX; ACT | 256 slots; independent bytes and optional installed-palette tests | PNG/VOX retain RGBA; ACT export is 768 RGB bytes, not general RGBA. Palette files are not renders. |
| OBJ basic/magica | Colored exposed surfaces, winding and axis/scale; magica writes MTL/palette PNG | Native asymmetric export verifies floor-half XY-centered pivot, 0.1 scale and Y-up geometry. Serialization order can differ. No interiors or native animation/cameras/lights. |
| PLY points/magica | Default colored points; explicit magica colored surface mesh | Native surface comparison verifies magica centered pivot, 0.1 scale and Z-up. Points remain default. |
| STL/glTF | Geometry/winding/units/buffers tested; glTF palette materials | STL has no palette here; no native scene animation/renderer metadata. |
| Qubicle QB | Raw/RLE matrices, color order/axes, independent bytes and actual native asymmetric export | Not the entire Qubicle project format. |
| XRAW | Unsigned RGBA8 indexed8 or direct rgba8, x-fastest; native indexed export verifies colored coordinates | Default export indexed8. Direct import preserves up to 255 occupied RGBA colors including partial alpha; larger input quantizes to opaque RGB with warnings. Histogram bounded to 65,536 RGB colors. Unsupported channel/index widths, invalid lengths/palette references rejected; alpha zero is empty in direct mode. |
| Headerless RAW | Explicit rgba8/rgb8/indexed8 and x-fastest/z-fastest order | Dimensions/encoding required, order defaults x-fastest. Indexed import needs 256-entry palette, index 0 empty. RGBA alpha 0 empty. RGB needs explicit unused emptyColor sentinel on import; export reports alpha loss and returns sentinel/layout metadata. No guessing. |
| Slab6 VOX | Native byte comparison verifies occupancy, Y/Z conversion and six-bit palette truncation | Not MagicaVoxel VOX. Z<=255; no alpha. |
| Build-engine KVX | Stored slabs, six-face masks, fixed8 pivot, validated mip chain; independently authored reference-layout fixtures | Export all occupied cells and one mip; import validates<=5 ceil-halved mips and returns highest resolution. X/Y unchanged, Z flipped to server Z-up. Pivot uses grid boundaries in exact 1/256 units. Z<=255, per-X relative offsets<=65535. Omitted native interiors are not invented: import warns and returns stored cells. Six-bit RGB, no alpha;>255 used colors quantize with warning. |
| Sponge schem v2/v3 | Grid/palette/varints, axes and block mapping; NBT/semantic tests | Blocks cannot preserve arbitrary colors/materials. Legacy schematic export separate. |
| PNG/GIF/spritesheet | Palette previews and explicit frame data | Not native path tracing. GIF has binary transparency and<=255 opaque colors. |
| Native Photo/Turntable/Anim | Actual PNG names/dimensions/CRCs verified | Windows opt-in; see [Native workflows](native-workflows.md). |

Save export_raw's returned metadata alongside its bytes: a headerless stream
cannot identify its dimensions, channel encoding, order, palette or RGB empty
sentinel. Unsupported RAW dialects are rejected, not silently guessed.

RAW, KVX and XRAW enforce 64 MiB byte budgets and<=2,000,000 occupied cells before
decoded voxel objects. KVX charges stored cells across all mips. General model,
scene and format-specific dimension budgets also apply.

## Native fixtures

`tests/fixtures/native-0.99.7.2` contains only exports of this project's own
asymmetric four-color 3x4x5 scene, not bundled application assets. Native
XRAW/QB/Slab6/OBJ/PLY comparisons run portably. KVX, RAW and direct-color XRAW
also use independently constructed bytes and malformed-input tests.

Compare mesh surfaces, pivot, dimensions and winding, not serialization order.
Account for six-bit quantization and do not expect hidden colors or scene
metadata to survive surface export.

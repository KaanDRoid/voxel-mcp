import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ModelRegistry } from "./model.js";
import type { VoxModelData } from "./vox.js";
import { defaultPalette } from "./vox.js";
import type { FilePolicy } from "./files.js";
import { AnimationRegistry, exportAnimationGIF } from "./animation.js";
import { exportOBJ, exportPLY, writeFileNoFollow } from "./export.js";
import { exportGLTF, exportSTL } from "./export_extra.js";
import { importOBJFile, importSVG } from "./importers.js";
import { AXIS_PATTERN } from "./formats/axes.js";
import { decodeQB, encodeQB } from "./formats/qb.js";
import { decodeXRAW, encodeXRAW } from "./formats/xraw.js";
import { decodeSlab6, encodeSlab6 } from "./formats/slab6.js";
import { decodeKVX, encodeKVX } from "./formats/kvx.js";
import { decodeRaw, encodeRaw } from "./formats/raw.js";
import { decodeSchem, encodeSchem } from "./formats/schem.js";
import { paletteFromAct, paletteFromPng, paletteFromVox, paletteToAct, paletteToPng, paletteToVox } from "./paletteFormats.js";
import { findNearestColors, mergeModelPalettes, quantizeModel, remapModelToPalette, sortModelPalette } from "./paletteOps.js";
import { parseCssColor } from "./color.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Tools of this module that never change server state. */
export const FORMAT_READ_ONLY = ["find_nearest_color"];

const id = z.string().min(1).max(64);
const axis = z.string().regex(AXIS_PATTERN, "Use three signed axes such as XYZ or XZ-Y").optional();
const scale = z.number().positive().max(1e6).optional();
const hexColor = z.string().max(32);
const metric = z.enum(["lab", "rgb"]).optional();

/** Registers palette file formats, palette operations, mesh/voxel format import and export tools. */
export function registerFormatTools(register: RegisterTool, registry: ModelRegistry, files: FilePolicy, anims: AnimationRegistry): void {
  const write = (file: string, data: Uint8Array | string) => writeFileNoFollow(file, data);
  const adopt = (data: VoxModelData, warnings: string[] = [], extra: Record<string, unknown> = {}): CallToolResult => {
    const { id: newId, model } = registry.create(data.sizeX, data.sizeY, data.sizeZ);
    model.voxels = data.voxels;
    if (data.palette) model.palette = data.palette;
    return text({ ...extra, id: newId, sizeX: data.sizeX, sizeY: data.sizeY, sizeZ: data.sizeZ, voxels: data.voxels.length, warnings });
  };

  // ---- palette files -------------------------------------------------------------------------
  const paletteImport = (name: string, label: string, read: (b: Buffer) => Uint32Array) =>
    register({ name, description: `Load the model palette from a ${label} file`, inputSchema: z.object({ id, path: z.string() }).strict() }, async ({ id: modelId, path }) => {
      const model = registry.get(modelId);
      model.palette = read(fs.readFileSync(path));
      return text({ id: modelId, loaded: path });
    });
  paletteImport("import_palette_png", "MagicaVoxel palette PNG (256x1; pixel k is voxel index k+1)", paletteFromPng);
  paletteImport("import_palette_act", "Adobe Color Table (.act, 768 or 772 bytes)", paletteFromAct);
  paletteImport("import_palette_vox", "VOX file with an RGBA chunk (such as a MagicaVoxel palette export)", paletteFromVox);
  register({ name: "export_palette_png", description: "Save the model palette as a MagicaVoxel-style 256x1 palette PNG", inputSchema: z.object({ id, path: z.string() }).strict() }, async ({ id: modelId, path }) => {
    write(path, paletteToPng(registry.get(modelId).palette ?? defaultPalette()));
    return text({ path });
  });
  register({ name: "export_palette_act", description: "Save the model palette as an Adobe Color Table (.act, 256 RGB entries; alpha is not stored)", inputSchema: z.object({ id, path: z.string(), trailer: z.boolean().optional() }).strict() }, async ({ id: modelId, path, trailer }) => {
    write(path, paletteToAct(registry.get(modelId).palette ?? defaultPalette(), { trailer: trailer ?? false }));
    return text({ path });
  });
  register({ name: "export_palette_vox", description: "Save the model palette as a VOX file holding one empty model and an RGBA chunk (layout of MagicaVoxel palette files is unverified)", inputSchema: z.object({ id, path: z.string() }).strict() }, async ({ id: modelId, path }) => {
    write(path, paletteToVox(registry.get(modelId).palette ?? defaultPalette()));
    return text({ path });
  });

  // ---- palette operations --------------------------------------------------------------------
  register({
    name: "remap_model_to_palette",
    description: "Replace the model palette with another palette (a model's palette via paletteId, or a .png/.act/.vox file via path) and move every voxel to the nearest color; reports the mean and maximum CIE76 color difference",
    inputSchema: z.object({ id, paletteId: id.optional(), path: z.string().optional(), metric }).strict(),
  }, async ({ id: modelId, paletteId, path, metric: m }) => {
    if ((paletteId === undefined) === (path === undefined)) throw new Error("Provide exactly one of paletteId or path");
    let target: Uint32Array;
    if (paletteId !== undefined) target = registry.get(paletteId).palette ?? defaultPalette();
    else {
      const ext = nodePath.extname(path!).toLowerCase(), data = fs.readFileSync(path!);
      if (ext === ".png") target = paletteFromPng(data);
      else if (ext === ".act") target = paletteFromAct(data);
      else if (ext === ".vox") target = paletteFromVox(data);
      else throw new Error("Palette file must be .png, .act or .vox");
    }
    return text(remapModelToPalette(registry.get(modelId), target, { metric: m ?? "lab" }));
  });
  register({ name: "quantize_model", description: "Reduce the number of distinct voxel colors to at most maxColors (median cut); reports color counts and color difference", inputSchema: z.object({ id, maxColors: z.number().int().min(1).max(255) }).strict() },
    async ({ id: modelId, maxColors }) => text(quantizeModel(registry.get(modelId), maxColors)));
  register({ name: "sort_palette", description: "Sort palette entries by hue or luminance and rewrite voxel indices so the model looks the same; transparent entries move to the end", inputSchema: z.object({ id, by: z.enum(["hue", "lum"]), descending: z.boolean().optional() }).strict() },
    async ({ id: modelId, by, descending }) => { sortModelPalette(registry.get(modelId), by, descending ?? false); return text({ id: modelId, sortedBy: by }); });
  register({ name: "find_nearest_color", description: "List the palette entries closest to a color (CSS #rrggbb) with their CIE76 color difference", inputSchema: z.object({ id, color: hexColor, count: z.number().int().min(1).max(32).optional(), metric }).strict() },
    async ({ id: modelId, color, count, metric: m }) => {
      const rgb = parseCssColor(color);
      if (!rgb) throw new Error("color must be #rgb, #rrggbb, rgb(r,g,b) or a basic color name");
      return text({ matches: findNearestColors(registry.get(modelId).palette ?? defaultPalette(), rgb, { count: count ?? 1, metric: m ?? "lab" }) });
    });
  register({ name: "merge_palettes", description: "Give several models one shared palette (union of used colors, quantized above 255) so they can be combined into one scene; reports the color difference", inputSchema: z.object({ ids: z.array(id).min(2).max(64) }).strict() },
    async ({ ids }) => text(mergeModelPalettes(ids.map(i => registry.get(i)))));

  // ---- meshes ----------------------------------------------------------------------------------
  register({
    name: "export_obj",
    description: "Export the model as a Wavefront OBJ. profile 'basic' writes one file with vertex colors; profile 'magica' follows the MagicaVoxel io_obj defaults (scale 0.1, merged faces) and also writes a .mtl and a palette PNG next to the OBJ. Default axis XZ-Y is Y-up; use XYZ for Z-up",
    inputSchema: z.object({ id, path: z.string(), profile: z.enum(["basic", "magica"]).optional(), scale, axis, cw: z.boolean().optional(), merge: z.boolean().optional() }).strict(),
  }, async ({ id: modelId, path, profile, scale: s, axis: a, cw, merge }) => text({ path, ...exportOBJ(registry.get(modelId), path, { profile, scale: s, axis: a, cw, merge }) }));
  register({ name: "export_ply", description: "Export ASCII PLY. Default points profile is a voxel point cloud; magica profile is an RGB surface mesh matching native XYZ/scale 0.1/floor-centered XY defaults. Custom axis, scale and winding are explicit overrides.", inputSchema: z.object({ id, path: z.string(), profile: z.enum(["points", "magica"]).optional(), scale, axis, cw: z.boolean().optional(), merge: z.boolean().optional() }).strict() },
    async ({ id: modelId, path, profile, scale: s, axis: a, cw, merge }) => { exportPLY(registry.get(modelId), path, { profile, scale: s, axis: a, cw, merge }); return text({ path }); });
  register({ name: "export_stl", description: "Export the model surface as ASCII STL; Z-up by default (axis XYZ), optional scale, axis and merged faces", inputSchema: z.object({ id, path: z.string(), scale, axis, merge: z.boolean().optional() }).strict() },
    async ({ id: modelId, path, scale: s, axis: a, merge }) => { exportSTL(registry.get(modelId), path, { scale: s, axis: a, merge }); return text({ path }); });
  register({ name: "export_gltf", description: "Export the model surface as glTF 2.0 with an embedded buffer; Y-up by default (axis XZ-Y), optional scale, axis and merged faces", inputSchema: z.object({ id, path: z.string(), scale, axis, merge: z.boolean().optional() }).strict() },
    async ({ id: modelId, path, scale: s, axis: a, merge }) => { exportGLTF(registry.get(modelId), path, { scale: s, axis: a, merge }); return text({ path }); });

  register({
    name: "import_obj",
    description: "Import an OBJ mesh into a new model. Closed meshes are filled solid (voxels whose centers are inside), open meshes keep their surface and report a warning. Colors come from textures (PNG via map_Kd), vertex colors or material Kd; the .mtl and textures must be inside the workspace. Size the grid with sizeX/sizeY/sizeZ (stretch to a box), fit.max (uniform, longest side) or scale (mesh units per voxel, default 1); axis XZ-Y (default, Y-up file) or XYZ",
    inputSchema: z.object({
      path: z.string(), sizeX: z.number().int().positive().max(256).optional(), sizeY: z.number().int().positive().max(256).optional(), sizeZ: z.number().int().positive().max(256).optional(),
      fit: z.object({ max: z.number().int().min(1).max(256) }).strict().optional(), scale, axis,
      fill: z.enum(["solid", "surface"]).optional(), color: z.enum(["auto", "none"]).optional(), defaultIndex: z.number().int().min(1).max(255).optional(),
      maxTriangles: z.number().int().min(1).max(2_000_000).optional(),
    }).strict(),
  }, async args => {
    const dir = nodePath.dirname(args.path);
    const readAux = (rel: string) => {
      try { return fs.readFileSync(files.resolve(nodePath.resolve(dir, rel), "read")); } catch { return undefined; }
    };
    const r = importOBJFile(args.path, { sizeX: args.sizeX, sizeY: args.sizeY, sizeZ: args.sizeZ, fit: args.fit, scale: args.scale, axis: args.axis, fill: args.fill, color: args.color, defaultIndex: args.defaultIndex, maxTriangles: args.maxTriangles, readAux });
    return adopt({ sizeX: r.sizeX, sizeY: r.sizeY, sizeZ: r.sizeZ, voxels: r.voxels, ...(r.palette ? { palette: r.palette } : {}) }, r.warnings);
  });
  register({
    name: "import_svg",
    description: "Rasterize filled SVG shapes into a new model and extrude them along Z. Supports rect (with rx/ry), circle, ellipse, polygon, polyline and path (M L H V C S Q T Z), groups, fill colors (#hex, rgb(), basic names), fill-rule, style and transforms; the viewBox is stretched to the model size. Strokes, text, gradients, CSS classes, clipping, opacity, use and arcs fail with an 'unsupported SVG' error",
    inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive().max(256), sizeY: z.number().int().positive().max(256), sizeZ: z.number().int().positive().max(256), thickness: z.number().int().positive().max(256).optional() }).strict(),
  }, async args => {
    const { id: newId, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
    const result = importSVG(model, args.path, { thickness: args.thickness ?? 1 });
    return text({ id: newId, voxels: result.count, warnings: result.warnings });
  });

  // ---- voxel formats ---------------------------------------------------------------------------
  register({ name: "export_qb", description: "Export the model as Qubicle Binary (.qb), Y-up, left-handed, RGBA or BGRA colors, optionally RLE-compressed (format layout unverified against Qubicle)", inputSchema: z.object({ id, path: z.string(), compress: z.boolean().optional(), colorFormat: z.enum(["rgba", "bgra"]).optional() }).strict() },
    async ({ id: modelId, path, compress, colorFormat }) => { write(path, encodeQB(registry.get(modelId), { compress, colorFormat })); return text({ path }); });
  register({ name: "import_qb", description: "Import a Qubicle Binary (.qb) file (all matrices are merged by position) into a new model; more than 255 colors are reduced with a warning", inputSchema: z.object({ path: z.string() }).strict() },
    async ({ path }) => { const r = decodeQB(fs.readFileSync(path)); return adopt(r.model, r.warnings); });
  register({ name: "export_xraw", description: "Export unsigned RGBA8 XRAW in indexed8 (default) or direct rgba8 mode. Native indexed XRAW axis/color mapping is regression-tested against an asymmetric MagicaVoxel export. Direct RGBA preserves nonzero partial alpha; alpha zero represents empty space.", inputSchema: z.object({ id, path: z.string(), encoding: z.enum(["indexed8", "rgba8"]).optional() }).strict() },
    async ({ id: modelId, path, encoding }) => { write(path, encodeXRAW(registry.get(modelId), { encoding })); return text({ path }); });
  register({ name: "import_xraw", description: "Import an XRAW file (8-bit palette indices, or direct RGBA voxels) into a new model", inputSchema: z.object({ path: z.string() }).strict() },
    async ({ path }) => { const r = decodeXRAW(fs.readFileSync(path)); return adopt(r.model, r.warnings); });
  register({ name: "export_slab6", description: "Export the model as a Slab6/SLABSPRI VOX file (uncompressed grid, 6-bit palette, Z size at most 255; this is not the MagicaVoxel VOX container)", inputSchema: z.object({ id, path: z.string() }).strict() },
    async ({ id: modelId, path }) => { write(path, encodeSlab6(registry.get(modelId))); return text({ path }); });
  register({ name: "import_slab6", description: "Import a Slab6/SLABSPRI VOX file (uncompressed grid; not the MagicaVoxel VOX container) into a new model", inputSchema: z.object({ path: z.string() }).strict() },
    async ({ path }) => { const r = decodeSlab6(fs.readFileSync(path)); return adopt(r.model, r.warnings); });

  register({ name: "export_kvx", description: "Export Build-engine KVX with one mip, fixed8 pivot, correct six-face slab visibility and 6-bit RGB palette. Writes every occupied cell; alpha and RGB precision are lossy. X/Y unchanged, Z reversed to native down; pivot uses Z-up grid boundary coordinates. A relative x-column offset above 65535 is refused.", inputSchema: z.object({ id, path: z.string(), pivot: z.tuple([z.number(), z.number(), z.number()]).optional() }).strict() }, async ({ id: modelId, path, pivot }) => {
    const model = registry.get(modelId);
    write(path, encodeKVX(model, pivot ? { pivot } : undefined));
    return text({ path, mipLevels: 1, pivot: pivot ?? [model.sizeX / 2, model.sizeY / 2, model.sizeZ / 2], warnings: ["KVX stores 6-bit RGB without alpha"] });
  });
  register({ name: "import_kvx", description: "Import validated Build-engine KVX (up to five mips); highest-resolution stored voxels only, without inventing implicit interiors. Returns Z-up boundary pivot and mip count. Six-bit RGB expands; more than 255 used colors are quantized with a warning.", inputSchema: z.object({ path: z.string() }).strict() }, async ({ path }) => {
    const result = decodeKVX(fs.readFileSync(path));
    return adopt(result.model, result.warnings, { pivot: result.pivot, mipLevels: result.mipLevels });
  });
  const encoding = z.enum(["rgba8", "rgb8", "indexed8"]).default("rgba8");
  const order = z.enum(["x-fastest", "z-fastest"]).default("x-fastest");
  const emptyColor = z.number().int().min(0).max(0xffffff).optional();
  register({ name: "export_raw", description: "Export headerless RGBA8, RGB8 or indexed8 data with explicit dimensions/order returned in metadata. Preserve that metadata for import. RGBA alpha zero is empty; RGB uses a collision-free empty-color sentinel and warns on alpha loss. Indexed output returns its 256-entry palette. No layout guessing.", inputSchema: z.object({ id, path: z.string(), encoding, order, emptyColor }).strict() }, async ({ id: modelId, path, encoding, order, emptyColor }) => {
    const result = encodeRaw(registry.get(modelId), { encoding, order, ...(emptyColor !== undefined ? { emptyColor } : {}) });
    write(path, result.data);
    return text({ path, metadata: result.metadata, warnings: result.warnings });
  });
  register({ name: "import_raw", description: "Import headerless RAW only with explicit dimensions, encoding and order. RGB without emptyColor treats every sample as occupied. Indexed zero is empty; palette defaults to the VOX default when omitted. Direct colors preserve RGBA exactly up to 255 unique occupied entries; larger color sets are refused, not silently reduced. Maximum 2 million occupied cells.", inputSchema: z.object({ path: z.string(), sizeX: z.number().int().min(1).max(256), sizeY: z.number().int().min(1).max(256), sizeZ: z.number().int().min(1).max(256), encoding, order, emptyColor, palette: z.array(z.number().int().min(0).max(0xffffffff)).length(256).optional() }).strict() }, async ({ path, sizeX, sizeY, sizeZ, encoding, order, emptyColor, palette }) => {
    if (palette !== undefined && encoding !== "indexed8") throw new Error("RAW palette applies only to indexed8 data");
    const result = decodeRaw(fs.readFileSync(path), { sizeX, sizeY, sizeZ, encoding, order, ...(emptyColor !== undefined ? { emptyColor } : {}), ...(palette ? { palette } : {}) });
    return adopt(result.model, result.warnings);
  });

  const blockEntry = z.object({ block: z.string().max(200), color: hexColor }).strict();
  register({
    name: "export_minecraft_schem",
    description: "Export the model as a Sponge .schem (gzip NBT, version 3 by default or 2). Voxel Z becomes Minecraft Y. Colors map to the nearest block of the built-in wool/concrete table (blockSet) or of a custom table (blocks: block id plus color); transparent entries become air",
    inputSchema: z.object({ id, path: z.string(), version: z.union([z.literal(2), z.literal(3)]).optional(), dataVersion: z.number().int().min(1).max(100000).optional(), blockSet: z.enum(["wool", "concrete", "both"]).optional(), blocks: z.array(blockEntry).min(1).max(256).optional() }).strict(),
  }, async ({ id: modelId, path, version, dataVersion, blockSet, blocks }) => { write(path, encodeSchem(registry.get(modelId), { version, dataVersion, blockSet, blocks })); return text({ path }); });
  register({
    name: "import_minecraft_schem",
    description: "Import a Sponge .schem (versions 1-3) into a new model; block types become palette entries using a built-in wool/concrete color table, the colors map (block id to CSS color) or a generated color with a warning",
    inputSchema: z.object({ path: z.string(), colors: z.record(z.string().max(200), hexColor).refine(v => Object.keys(v).length <= 256, "At most 256 colors").optional() }).strict(),
  }, async ({ path, colors }) => { const r = decodeSchem(fs.readFileSync(path), { colors }); return adopt(r.model, r.warnings); });

  // ---- animation -------------------------------------------------------------------------------
  register({
    name: "export_animation_gif",
    description: "Export an animation as a GIF using frame durations. A frame can use at most maxColors (default 255) opaque colors: quantize 'median-cut' reduces more colors (reported in warnings), dither 'floyd' adds error diffusion; with quantize 'none' too many colors fail",
    inputSchema: z.object({ animationId: z.string(), path: z.string(), projection: z.enum(["top", "front", "side", "zmax", "isometric"]).optional(), quantize: z.enum(["none", "median-cut"]).optional(), dither: z.enum(["none", "floyd"]).optional(), maxColors: z.number().int().min(2).max(255).optional() }).strict(),
  }, async ({ animationId, path, projection, quantize, dither, maxColors }) => {
    const result = exportAnimationGIF(anims.getData(animationId), path, projection ?? "isometric", { quantize, dither, maxColors });
    return text({ path, ...result });
  });
}

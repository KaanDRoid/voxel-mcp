import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { MagicaConfig } from "./magicaConfig.js";
import { ModelRegistry, fillBox, fillSphere, fillCylinder, fillPyramid, fillCone, fillTorus, drawLine, setVoxels, translate, rotate90, booleanOp, scaleModel, cloneModel, clearRegion, copyRegion, pasteRegion, getModelInfo, cropToContent, centerModel, alignToGround, flipModel, rotateArbitrary } from "./model.js";
import { saveVOX, loadVOX } from "./vox.js";
import { generateHouse, generateCharacter, generateFromPrompt, imageToVoxel, generateVehicle, generateFurniture, generateWeapon, generateStructure, generateCreature, generateNature, generateAnkaraBlock, generateVenueInterior, generateVenueCharacter, generateStaff, generateCustomer } from "./generators.js";
import type { StaffType, CustomerType } from "./generators.js";
import { imageToVoxelColorized, silhouetteTo3D, edgeDetectToVoxel, depthMapToVoxel, multiViewToVoxel } from "./image.js";
import { deduplicateVoxels, mirror, hollow, floodFill, applyNoise, generateTerrain, generateTree, replaceColor, applyPattern, applyGradient, randomizeSurfaceColor, erode, dilate, outline, smoothModel, extrudeFace, bevelEdges, addDetailNoise } from "./ops.js";
import { setPaletteIndex, loadPaletteFromPng, savePaletteToPng, generatePalette, extractPaletteFromImage, applyPaletteToModel, blendPalettes } from "./palette.js";
import { measureDistance, getSurfaceArea, getVolume, findCenter, getDimensions, countColors } from "./analysis.js";
import { exportOBJ, exportPLY, exportSlices } from "./export.js";
import { exportSTL, exportGLTF, exportMinecraftSchematic } from "./export_extra.js";
import { importOBJ, importSVG } from "./importers.js";
import { AnimationRegistry, exportAnimationSpriteSheet, exportAnimationGIF, interpolateFrames, exportAnimationFrames, renderFrameToPNG } from "./animation.js";
import { autoUvColor, detectSymmetry, makeSymmetric, simplifyModel, voxelizeText } from "./smart.js";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

// Clipboard for copy/paste operations
const clipboard: { voxels: { x: number; y: number; z: number; i: number }[] } = { voxels: [] };

export function createTools(server: McpServer, registry: ModelRegistry, config: MagicaConfig) {
  // create_model
  server.tool(
    {
      name: "create_model",
      description: "Create a new empty model with given dimensions.",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive() }).strict(),
    },
    async (args: any) => {
      const { sizeX, sizeY, sizeZ } = args as any;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      return { content: [{ type: "text", text: JSON.stringify({ id, sizeX, sizeY, sizeZ }) }] };
    }
  );

  // image_to_voxel_colorized
  server.tool(
    {
      name: "image_to_voxel_colorized",
      description: "Convert an image to a colorized voxel model using palette quantization (flat or heightmap)",
      inputSchema: z
        .object({
          path: z.string(),
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          mode: z.enum(["flat", "heightmap"]).optional(),
          maxZ: z.number().int().positive().optional(),
          threshold: z.number().int().min(0).max(255).optional(),
          downscale: z.number().int().positive().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      await imageToVoxelColorized(model, abs, {
        mode: args.mode ?? "flat",
        maxZ: args.maxZ ?? args.sizeZ,
        threshold: args.threshold ?? 16,
        downscale: args.downscale ?? 1,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // image_silhouette_to_3d
  server.tool(
    {
      name: "image_silhouette_to_3d",
      description: "Extrude image silhouette (alpha/brightness) into a 3D voxel volume",
      inputSchema: z
        .object({
          path: z.string(),
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          thickness: z.number().int().positive(),
          threshold: z.number().int().min(0).max(255).optional(),
          downscale: z.number().int().positive().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      await silhouetteTo3D(model, abs, {
        thickness: Math.min(args.thickness, args.sizeZ),
        threshold: args.threshold ?? 16,
        downscale: args.downscale ?? 1,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // edge_detect_to_voxel
  server.tool(
    {
      name: "edge_detect_to_voxel",
      description: "Run Sobel edge detection on image and rasterize edges as a wireframe voxel layer",
      inputSchema: z
        .object({
          path: z.string(),
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          threshold: z.number().int().min(0).max(255).optional(),
          downscale: z.number().int().positive().optional(),
          i: z.number().int().min(1).max(255).optional(),
          z: z.number().int().min(0).optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      await edgeDetectToVoxel(model, abs, {
        threshold: args.threshold ?? 64,
        downscale: args.downscale ?? 1,
        i: args.i ?? 250,
        z: Math.min(args.z ?? 0, args.sizeZ - 1),
      });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // depth_map_to_voxel
  server.tool(
    {
      name: "depth_map_to_voxel",
      description: "Interpret an image as a depth map and place voxels at corresponding Z depths",
      inputSchema: z
        .object({
          path: z.string(),
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          invert: z.boolean().optional(),
          downscale: z.number().int().positive().optional(),
          i: z.number().int().min(1).max(255).optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      await depthMapToVoxel(model, abs, {
        invert: args.invert ?? false,
        downscale: args.downscale ?? 1,
        i: args.i ?? 180,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // multi_view_to_voxel
  server.tool(
    {
      name: "multi_view_to_voxel",
      description: "Approximate visual hull from front/side/top silhouette images (space carving)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          frontPath: z.string().optional(),
          sidePath: z.string().optional(),
          topPath: z.string().optional(),
          downscale: z.number().int().positive().optional(),
          threshold: z.number().int().min(0).max(255).optional(),
          colorFrom: z.enum(["top", "front", "side", "none"]).optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const norm = (p?: string) => (p ? (path.isAbsolute(p) ? p : path.join(process.cwd(), p)) : undefined);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      const opts: any = {
        downscale: args.downscale ?? 1,
        threshold: args.threshold ?? 16,
        colorFrom: args.colorFrom ?? (args.topPath ? "top" : args.frontPath ? "front" : args.sidePath ? "side" : "none"),
      };
      const F = norm(args.frontPath);
      const S = norm(args.sidePath);
      const T = norm(args.topPath);
      if (F) opts.frontPath = F;
      if (S) opts.sidePath = S;
      if (T) opts.topPath = T;
      await multiViewToVoxel(model, opts);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // list_models
  server.tool(
    {
      name: "list_models",
      description: "List in-memory models",
      inputSchema: z.object({}).strict(),
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(registry.list()) }] })
  );

  // fill_box
  server.tool(
    {
      name: "fill_box",
      description: "Fill a box region with a palette index",
      inputSchema: z
        .object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int(), i: z.number().int().min(1).max(255) })
        .strict(),
    },
    async (args: any) => {
      const { id, x0, y0, z0, x1, y1, z1, i } = args;
      const m = registry.get(id);
      fillBox(m, x0, y0, z0, x1, y1, z1, i);
      return { content: [{ type: "text", text: `filled box in model ${id}` }] };
    }
  );

  // fill_sphere
  server.tool(
    {
      name: "fill_sphere",
      description: "Fill a sphere with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), cz: z.number().int(), r: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, cx, cy, cz, r, i } = args;
      const m = registry.get(id);
      fillSphere(m, cx, cy, cz, r, i);
      return { content: [{ type: "text", text: `filled sphere in model ${id}` }] };
    }
  );

  // fill_cylinder
  server.tool(
    {
      name: "fill_cylinder",
      description: "Fill a vertical cylinder with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), z0: z.number().int(), z1: z.number().int(), r: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, cx, cy, z0, z1, r, i } = args;
      const m = registry.get(id);
      fillCylinder(m, cx, cy, z0, z1, r, i);
      return { content: [{ type: "text", text: `filled cylinder in model ${id}` }] };
    }
  );

  // fill_pyramid
  server.tool(
    {
      name: "fill_pyramid",
      description: "Fill a pyramid shape with a palette index",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), height: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, x0, y0, z0, x1, y1, height, i } = args;
      const m = registry.get(id);
      fillPyramid(m, x0, y0, z0, x1, y1, height, i);
      return { content: [{ type: "text", text: `filled pyramid in model ${id}` }] };
    }
  );

  // fill_cone
  server.tool(
    {
      name: "fill_cone",
      description: "Fill a cone shape with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), z0: z.number().int(), r: z.number().int().positive(), height: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, cx, cy, z0, r, height, i } = args;
      const m = registry.get(id);
      fillCone(m, cx, cy, z0, r, height, i);
      return { content: [{ type: "text", text: `filled cone in model ${id}` }] };
    }
  );

  // fill_torus
  server.tool(
    {
      name: "fill_torus",
      description: "Fill a torus (donut) shape with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), cz: z.number().int(), majorR: z.number().int().positive(), minorR: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, cx, cy, cz, majorR, minorR, i } = args;
      const m = registry.get(id);
      fillTorus(m, cx, cy, cz, majorR, minorR, i);
      return { content: [{ type: "text", text: `filled torus in model ${id}` }] };
    }
  );

  // draw_line
  server.tool(
    {
      name: "draw_line",
      description: "Draw a 3D line between two points",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const { id, x0, y0, z0, x1, y1, z1, i } = args;
      const m = registry.get(id);
      drawLine(m, x0, y0, z0, x1, y1, z1, i);
      return { content: [{ type: "text", text: `drew line in model ${id}` }] };
    }
  );

  // set_voxels
  server.tool(
    {
      name: "set_voxels",
      description: "Add explicit voxels",
      inputSchema: z.object({ id: z.string(), voxels: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), i: z.number().int().min(1).max(255) }).strict()) }).strict(),
    },
    async (args: any) => {
      const { id, voxels } = args;
      const m = registry.get(id);
      setVoxels(m, voxels);
      return { content: [{ type: "text", text: `added ${voxels.length} voxels to model ${id}` }] };
    }
  );

  // transform_translate
  server.tool(
    {
      name: "transform_translate",
      description: "Translate a model in place",
      inputSchema: z.object({ id: z.string(), dx: z.number().int(), dy: z.number().int(), dz: z.number().int() }).strict(),
    },
    async (args: any) => {
      const { id, dx, dy, dz } = args;
      const m = registry.get(id);
      translate(m, dx, dy, dz);
      return { content: [{ type: "text", text: `translated model ${id}` }] };
    }
  );

  // transform_rotate90
  server.tool(
    {
      name: "transform_rotate90",
      description: "Rotate model by 90 degrees around an axis",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict(),
    },
    async (args: any) => {
      const { id, axis } = args;
      const m = registry.get(id);
      rotate90(m, axis);
      return { content: [{ type: "text", text: `rotated model ${id} around ${axis}` }] };
    }
  );

  // crop_to_content
  server.tool(
    { name: "crop_to_content", description: "Crop model size to its bounding content", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); cropToContent(m); return { content: [{ type: "text", text: `cropped ${args.id}` }] }; }
  );

  // center_model
  server.tool(
    { name: "center_model", description: "Center model content within its size", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); centerModel(m); return { content: [{ type: "text", text: `centered ${args.id}` }] }; }
  );

  // align_to_ground
  server.tool(
    { name: "align_to_ground", description: "Translate model so Z-min sits at 0", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); alignToGround(m); return { content: [{ type: "text", text: `aligned to ground ${args.id}` }] }; }
  );

  // flip_model
  server.tool(
    { name: "flip_model", description: "Flip model across an axis (no duplication)", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict() },
    async (args: any) => { const m = registry.get(args.id); flipModel(m, args.axis); return { content: [{ type: "text", text: `flipped ${args.id}` }] }; }
  );

  // rotate_arbitrary
  server.tool(
    { name: "rotate_arbitrary", description: "Rotate around axis by arbitrary degrees (voxel approx)", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), degrees: z.number() }).strict() },
    async (args: any) => { const m = registry.get(args.id); rotateArbitrary(m, args.axis, args.degrees); return { content: [{ type: "text", text: `rotated ${args.id}` }] }; }
  );

  // boolean_op
  server.tool(
    {
      name: "boolean_op",
      description: "Boolean op (union|intersect|difference) between two models; returns new model id",
      inputSchema: z.object({ a: z.string(), b: z.string(), op: z.enum(["union", "intersect", "difference"]) }).strict(),
    },
    async (args: any) => {
      const { a, b, op } = args;
      const am = registry.get(a);
      const bm = registry.get(b);
      const out = booleanOp(am, bm, op);
      const { id } = registry.create(out.sizeX, out.sizeY, out.sizeZ);
      registry.set(id, out);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // scale_model
  server.tool(
    {
      name: "scale_model",
      description: "Scale a model by factors; returns new model id",
      inputSchema: z.object({ id: z.string(), scaleX: z.number().positive(), scaleY: z.number().positive(), scaleZ: z.number().positive() }).strict(),
    },
    async (args: any) => {
      const { id, scaleX, scaleY, scaleZ } = args;
      const m = registry.get(id);
      const out = scaleModel(m, scaleX, scaleY, scaleZ);
      const { id: newId } = registry.create(out.sizeX, out.sizeY, out.sizeZ);
      registry.set(newId, out);
      return { content: [{ type: "text", text: JSON.stringify({ id: newId, size: [out.sizeX, out.sizeY, out.sizeZ] }) }] };
    }
  );

  // clone_model
  server.tool(
    {
      name: "clone_model",
      description: "Clone a model; returns new model id",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const out = cloneModel(m);
      const { id: newId } = registry.create(out.sizeX, out.sizeY, out.sizeZ);
      registry.set(newId, out);
      return { content: [{ type: "text", text: JSON.stringify({ id: newId }) }] };
    }
  );

  // delete_model
  server.tool(
    {
      name: "delete_model",
      description: "Delete a model from memory",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args: any) => {
      registry.delete(args.id);
      return { content: [{ type: "text", text: `deleted model ${args.id}` }] };
    }
  );

  // clear_model
  server.tool(
    {
      name: "clear_model",
      description: "Clear all voxels from a model",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      m.voxels = [];
      return { content: [{ type: "text", text: `cleared model ${args.id}` }] };
    }
  );

  // clear_region
  server.tool(
    {
      name: "clear_region",
      description: "Clear voxels in a region",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int() }).strict(),
    },
    async (args: any) => {
      const { id, x0, y0, z0, x1, y1, z1 } = args;
      const m = registry.get(id);
      clearRegion(m, x0, y0, z0, x1, y1, z1);
      return { content: [{ type: "text", text: `cleared region in model ${id}` }] };
    }
  );

  // copy_region
  server.tool(
    {
      name: "copy_region",
      description: "Copy voxels in a region to clipboard",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int() }).strict(),
    },
    async (args: any) => {
      const { id, x0, y0, z0, x1, y1, z1 } = args;
      const m = registry.get(id);
      clipboard.voxels = copyRegion(m, x0, y0, z0, x1, y1, z1);
      return { content: [{ type: "text", text: `copied ${clipboard.voxels.length} voxels to clipboard` }] };
    }
  );

  // paste_region
  server.tool(
    {
      name: "paste_region",
      description: "Paste voxels from clipboard at offset",
      inputSchema: z.object({ id: z.string(), offsetX: z.number().int(), offsetY: z.number().int(), offsetZ: z.number().int() }).strict(),
    },
    async (args: any) => {
      const { id, offsetX, offsetY, offsetZ } = args;
      const m = registry.get(id);
      pasteRegion(m, clipboard.voxels, offsetX, offsetY, offsetZ);
      return { content: [{ type: "text", text: `pasted ${clipboard.voxels.length} voxels to model ${id}` }] };
    }
  );

  // get_model_info
  server.tool(
    {
      name: "get_model_info",
      description: "Get detailed info about a model (size, voxel count, bounding box, used colors)",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const info = getModelInfo(m);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    }
  );

  // save_vox
  server.tool(
    {
      name: "save_vox",
      description: "Save a model to a .vox file",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args: any) => {
      const { id, path: outPath } = args;
      const m = registry.get(id);
      const abs = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      saveVOX(abs, m);
      return { content: [{ type: "text", text: `saved ${abs}` }] };
    }
  );

  // set_model_palette
  server.tool(
    {
      name: "set_model_palette",
      description: "Set RGBA palette for a model (array of 256 uint32 RGBA values)",
      inputSchema: z.object({ id: z.string(), palette: z.array(z.number().int()).length(256) }).strict(),
    },
    async (args: any) => {
      const { id, palette } = args;
      const m = registry.get(id);
      m.palette = new Uint32Array(palette.map((v: number) => v >>> 0));
      return { content: [{ type: "text", text: `palette set for model ${id}` }] };
    }
  );

  // generate_house
  server.tool(
    {
      name: "generate_house",
      description: "Procedurally generate a house in a new model",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), floors: z.number().int().positive().optional(), style: z.string().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args: any) => {
      const { sizeX, sizeY, sizeZ, floors, style, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateHouse(model, { floors: floors ?? 2, style: style ?? "modern", seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_character
  server.tool(
    {
      name: "generate_character",
      description: "Procedurally generate a humanoid character in a new model",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), style: z.string().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args: any) => {
      const { sizeX, sizeY, sizeZ, style, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateCharacter(model, { style: style ?? "default", seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_from_prompt
  server.tool(
    {
      name: "generate_from_prompt",
      description: "Generate a model from a natural language prompt using built-in procedural patterns",
      inputSchema: z.object({ prompt: z.string(), sizeX: z.number().int().positive().optional(), sizeY: z.number().int().positive().optional(), sizeZ: z.number().int().positive().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args: any) => {
      const sizeX = args.sizeX ?? 96;
      const sizeY = args.sizeY ?? 96;
      const sizeZ = args.sizeZ ?? 96;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      await generateFromPrompt(model, args.prompt, { seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // image_to_voxel
  server.tool(
    {
      name: "image_to_voxel",
      description: "Convert an image to a voxel model (heightmap or extrude modes)",
      inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), mode: z.enum(["heightmap", "extrude"]).optional(), maxZ: z.number().int().positive().optional(), threshold: z.number().int().min(0).max(255).optional(), downscale: z.number().int().positive().optional() }).strict(),
    },
    async (args: any) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      await imageToVoxel(model, abs, {
        mode: args.mode ?? "heightmap",
        maxZ: args.maxZ ?? args.sizeZ,
        threshold: args.threshold ?? 127,
        downscale: args.downscale ?? 1,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_vehicle
  server.tool(
    {
      name: "generate_vehicle",
      description: "Generate a parametric vehicle model (car/truck/spaceship/boat/plane/tank/motorcycle/helicopter)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["car", "truck", "spaceship", "boat", "plane", "tank", "motorcycle", "helicopter"]),
          style: z.enum(["realistic", "cartoon", "lowpoly", "scifi"]).optional(),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateVehicle(model, { type: args.type, style: args.style ?? "lowpoly", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_structure
  server.tool(
    {
      name: "generate_structure",
      description: "Generate parametric structures (castle/tower/bridge/wall/gate/temple/pyramid/lighthouse)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["castle", "tower", "bridge", "wall", "gate", "temple", "pyramid", "lighthouse"]),
          style: z.enum(["medieval", "asian", "modern", "fantasy"]).optional(),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateStructure(model, { type: args.type, style: args.style ?? "medieval", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // apply_pattern
  server.tool(
    {
      name: "apply_pattern",
      description: "Apply procedural pattern to model colors",
      inputSchema: z
        .object({
          id: z.string(),
          pattern: z.enum(["checker", "stripes", "dots", "gradient", "noise", "brick", "wood", "scales"]),
          colors: z.array(z.number().int().min(1).max(255)).min(1),
          scale: z.number().int().positive(),
        })
        .strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      applyPattern(m, args.pattern, args.colors, args.scale);
      return { content: [{ type: "text", text: `pattern applied to ${args.id}` }] };
    }
  );

  // apply_gradient
  server.tool(
    {
      name: "apply_gradient",
      description: "Apply 2-color gradient along an axis",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), i0: z.number().int().min(1).max(255), i1: z.number().int().min(1).max(255) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      applyGradient(m, args.axis, args.i0, args.i1);
      return { content: [{ type: "text", text: `gradient applied to ${args.id}` }] };
    }
  );

  // randomize_surface_color
  server.tool(
    {
      name: "randomize_surface_color",
      description: "Add subtle random color variation to surface voxels",
      inputSchema: z.object({ id: z.string(), delta: z.number().int().positive() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      randomizeSurfaceColor(m, Math.max(1, args.delta));
      return { content: [{ type: "text", text: `surface color randomized for ${args.id}` }] };
    }
  );

  // erode
  server.tool(
    { name: "erode", description: "Morphological erosion of model", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); erode(m, args.iterations ?? 1); return { content: [{ type: "text", text: `eroded ${args.id}` }] }; }
  );

  // dilate
  server.tool(
    { name: "dilate", description: "Morphological dilation of model", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional(), i: z.number().int().min(1).max(255).optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); dilate(m, args.iterations ?? 1, args.i); return { content: [{ type: "text", text: `dilated ${args.id}` }] }; }
  );

  // outline
  server.tool(
    { name: "outline", description: "Keep only outer shell voxels (wireframe effect)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); outline(m); return { content: [{ type: "text", text: `outlined ${args.id}` }] }; }
  );

  // smooth_model
  server.tool(
    { name: "smooth_model", description: "Smooth model via majority filter", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); smoothModel(m, args.iterations ?? 1); return { content: [{ type: "text", text: `smoothed ${args.id}` }] }; }
  );

  // extrude_face
  server.tool(
    { name: "extrude_face", description: "Extrude exposed faces along an axis", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), amount: z.number().int().positive(), i: z.number().int().min(1).max(255).optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); extrudeFace(m, args.axis, args.amount, args.i); return { content: [{ type: "text", text: `extruded ${args.id}` }] }; }
  );

  // bevel_edges
  server.tool(
    { name: "bevel_edges", description: "Soften edges by removing sharp corner voxels", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); bevelEdges(m); return { content: [{ type: "text", text: `beveled ${args.id}` }] }; }
  );

  // add_detail_noise
  server.tool(
    { name: "add_detail_noise", description: "Add micro surface detail using noise displacement", inputSchema: z.object({ id: z.string(), scale: z.number().positive(), intensity: z.number().int().positive(), seed: z.number().int().optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); addDetailNoise(m, args.scale, args.intensity, args.seed ?? 0); return { content: [{ type: "text", text: `detail noise added to ${args.id}` }] }; }
  );

  // generate_furniture
  server.tool(
    {
      name: "generate_furniture",
      description: "Generate parametric furniture (chair/table/bed/shelf/lamp/sofa/desk/cabinet)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["chair", "table", "bed", "shelf", "lamp", "sofa", "desk", "cabinet"]),
          style: z.enum(["modern", "classic", "medieval", "scifi"]).optional(),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateFurniture(model, { type: args.type, style: args.style ?? "modern", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_weapon
  server.tool(
    {
      name: "generate_weapon",
      description: "Generate parametric weapons (sword/axe/hammer/spear/bow/gun/staff/shield/dagger)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["sword", "axe", "hammer", "spear", "bow", "gun", "staff", "shield", "dagger"]),
          style: z.enum(["medieval", "fantasy", "scifi", "steampunk"]).optional(),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateWeapon(model, { type: args.type, style: args.style ?? "medieval", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_creature
  server.tool(
    {
      name: "generate_creature",
      description: "Generate creatures (dog/cat/bird/dragon/horse/snake/spider/robot/fish)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["dog", "cat", "bird", "fish", "dragon", "horse", "snake", "spider", "robot"]),
          style: z.enum(["realistic", "cute", "monster", "cartoon"]).optional(),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateCreature(model, { type: args.type, style: args.style ?? "cartoon", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_nature
  server.tool(
    {
      name: "generate_nature",
      description: "Generate nature assets (rock/crystal/cloud/mountain/island/cave/mushroom/flower)",
      inputSchema: z
        .object({
          sizeX: z.number().int().positive(),
          sizeY: z.number().int().positive(),
          sizeZ: z.number().int().positive(),
          type: z.enum(["rock", "crystal", "cloud", "mountain", "island", "cave", "mushroom", "flower"]),
          seed: z.number().int().optional(),
        })
        .strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateNature(model, { type: args.type, seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // Nightlife: Ankara-inspired city block
  server.tool(
    { name: "generate_ankara_block", description: "Generate a city block layout inspired by Ankara (roads + buildings)", inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), roads: z.boolean().optional(), seed: z.number().int().optional() }).strict() },
    async (args: any) => { const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); generateAnkaraBlock(model, { roads: args.roads ?? true, seed: args.seed ?? 0 }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );
  // Nightlife: venue interior
  server.tool(
    { name: "generate_venue_interior", description: "Generate a venue interior (stage, bar, tables, neon)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); generateVenueInterior(m, {}); return { content: [{ type: "text", text: `generated venue interior in ${args.id}` }] }; }
  );
  // Nightlife: character shell (legacy)
  server.tool(
    { name: "generate_venue_character", description: "Generate a themed humanoid character for a venue/nightclub scenario", inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), role: z.enum(["konsomatris","musteri","garson","asci","polis","mafya","behzatc"]) }).strict() },
    async (args: any) => { const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); generateVenueCharacter(model, { role: args.role }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );

  // ===== STAFF CHARACTER GENERATOR =====
  server.tool(
    {
      name: "generate_staff",
      description: "Generate detailed staff/employee character for a nightclub/venue. Types: barman (bartender with shaker), chef (cook with hat & pan), cleaner (mop & uniform), konsomatris (elegant hostess), musician (with instrument), security (bouncer with sunglasses), waiter (tray & bow tie)",
      inputSchema: z.object({
        sizeX: z.number().int().positive().default(32),
        sizeY: z.number().int().positive().default(32),
        sizeZ: z.number().int().positive().default(48),
        type: z.enum(["barman", "chef", "cleaner", "konsomatris", "musician", "security", "waiter"]),
        style: z.enum(["default", "fancy", "casual"]).optional(),
        seed: z.number().int().optional()
      }).strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX ?? 32, args.sizeY ?? 32, args.sizeZ ?? 48);
      generateStaff(model, { type: args.type, style: args.style ?? "default", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id, type: args.type, description: getStaffDescription(args.type) }) }] };
    }
  );

  // ===== CUSTOMER CHARACTER GENERATOR =====
  server.tool(
    {
      name: "generate_customer",
      description: "Generate detailed customer character for a nightclub/venue. Types: regular (normal customer), worker (blue-collar with hard hat), elite (rich in suit), nostalgic (old-timer with flat cap), emotional (sad with tissue), young (trendy with phone), bureaucrat (government employee with briefcase), undercover (plain-clothes cop with earpiece), sapkali (farmer who sold his land), gangster (mafioso with gold chain), foreign (tourist with camera), vip (flashy with champagne), behzatc (Behzat C. style - leather jacket, cigarette, raki)",
      inputSchema: z.object({
        sizeX: z.number().int().positive().default(32),
        sizeY: z.number().int().positive().default(32),
        sizeZ: z.number().int().positive().default(48),
        type: z.enum(["regular", "worker", "elite", "nostalgic", "emotional", "young", "bureaucrat", "undercover", "sapkali", "gangster", "foreign", "vip", "behzatc"]),
        pose: z.enum(["standing", "sitting", "drinking"]).optional(),
        seed: z.number().int().optional()
      }).strict(),
    },
    async (args: any) => {
      const { id, model } = registry.create(args.sizeX ?? 32, args.sizeY ?? 32, args.sizeZ ?? 48);
      generateCustomer(model, { type: args.type, pose: args.pose ?? "standing", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id, type: args.type, pose: args.pose ?? "standing", description: getCustomerDescription(args.type) }) }] };
    }
  );

  // deduplicate_voxels
  server.tool(
    {
      name: "deduplicate_voxels",
      description: "Remove duplicate voxels at the same coordinates",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const before = m.voxels.length;
      deduplicateVoxels(m);
      const after = m.voxels.length;
      return { content: [{ type: "text", text: `deduplicated: ${before} -> ${after}` }] };
    }
  );

  // mirror_model
  server.tool(
    {
      name: "mirror_model",
      description: "Mirror model across an axis and merge",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      mirror(m, args.axis);
      return { content: [{ type: "text", text: `mirrored ${args.id} on ${args.axis}` }] };
    }
  );

  // hollow_model
  server.tool(
    {
      name: "hollow_model",
      description: "Make a hollow shell by removing interior voxels",
      inputSchema: z.object({ id: z.string(), thickness: z.number().int().min(1).max(8).default(1) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      hollow(m, args.thickness ?? 1);
      return { content: [{ type: "text", text: `hollowed ${args.id} thickness ${args.thickness ?? 1}` }] };
    }
  );

  // flood_fill
  server.tool(
    {
      name: "flood_fill",
      description: "Flood fill contiguous region from a seed coordinate",
      inputSchema: z.object({ id: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(), targetIndex: z.number().int().min(0).max(255), newIndex: z.number().int().min(0).max(255) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const changed = floodFill(m, args.x, args.y, args.z, args.targetIndex, args.newIndex);
      return { content: [{ type: "text", text: `flood filled ${changed} voxels in ${args.id}` }] };
    }
  );

  // palette tools
  server.tool(
    {
      name: "set_palette_index",
      description: "Set RGBA value of a palette index",
      inputSchema: z.object({ id: z.string(), index: z.number().int().min(0).max(255), rgba: z.number().int() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      setPaletteIndex(m, args.index, args.rgba);
      return { content: [{ type: "text", text: `set palette[${args.index}]` }] };
    }
  );

  server.tool(
    {
      name: "load_palette_from_png",
      description: "Load first 256 pixels of a PNG into palette",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      loadPaletteFromPng(m, abs);
      return { content: [{ type: "text", text: `palette loaded from ${abs}` }] };
    }
  );

  server.tool(
    {
      name: "save_palette_to_png",
      description: "Save palette to 16x16 PNG",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      savePaletteToPng(m, abs);
      return { content: [{ type: "text", text: `palette saved to ${abs}` }] };
    }
  );

  // Export tools
  server.tool(
    {
      name: "export_obj",
      description: "Export model to OBJ mesh format",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      exportOBJ(m, abs);
      return { content: [{ type: "text", text: `exported OBJ to ${abs}` }] };
    }
  );

  server.tool(
    {
      name: "export_ply",
      description: "Export model to PLY point cloud format",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      exportPLY(m, abs);
      return { content: [{ type: "text", text: `exported PLY to ${abs}` }] };
    }
  );

  server.tool(
    {
      name: "export_slices",
      description: "Export model as PNG slices (one per Z layer)",
      inputSchema: z.object({ id: z.string(), folder: z.string() }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.folder) ? args.folder : path.join(process.cwd(), args.folder);
      exportSlices(m, abs);
      return { content: [{ type: "text", text: `exported slices to ${abs}` }] };
    }
  );

  // Terrain and procedural tools
  server.tool(
    {
      name: "generate_terrain",
      description: "Generate procedural terrain using fractal noise",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), octaves: z.number().int().min(1).max(8).default(4), persistence: z.number().min(0).max(1).default(0.5), scale: z.number().positive().default(20), seed: z.number().int().default(0) }).strict(),
    },
    async (args: any) => {
      const { sizeX, sizeY, sizeZ, octaves, persistence, scale, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateTerrain(model, { octaves: octaves ?? 4, persistence: persistence ?? 0.5, scale: scale ?? 20, seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  server.tool(
    {
      name: "apply_noise",
      description: "Apply noise displacement to existing voxels",
      inputSchema: z.object({ id: z.string(), scale: z.number().positive().default(10), intensity: z.number().positive().default(5), seed: z.number().int().default(0) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      applyNoise(m, args.scale ?? 10, args.intensity ?? 5, args.seed ?? 0);
      return { content: [{ type: "text", text: `applied noise to ${args.id}` }] };
    }
  );

  server.tool(
    {
      name: "generate_tree",
      description: "Generate a tree at specified position",
      inputSchema: z.object({ id: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(), style: z.enum(["oak", "pine", "palm"]).default("oak"), seed: z.number().int().default(0) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      generateTree(m, args.x, args.y, args.z, args.style ?? "oak", args.seed ?? 0);
      return { content: [{ type: "text", text: `generated ${args.style ?? "oak"} tree in ${args.id}` }] };
    }
  );

  server.tool(
    {
      name: "replace_color",
      description: "Replace all voxels of one color with another",
      inputSchema: z.object({ id: z.string(), oldIndex: z.number().int().min(0).max(255), newIndex: z.number().int().min(0).max(255) }).strict(),
    },
    async (args: any) => {
      const m = registry.get(args.id);
      const count = replaceColor(m, args.oldIndex, args.newIndex);
      return { content: [{ type: "text", text: `replaced ${count} voxels in ${args.id}` }] };
    }
  );

  // Export extensions
  server.tool(
    { name: "export_stl", description: "Export model as ASCII STL", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportSTL(m, abs); return { content: [{ type: "text", text: `exported STL to ${abs}` }] }; }
  );
  server.tool(
    { name: "export_gltf", description: "Export model as minimal glTF 2.0", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportGLTF(m, abs); return { content: [{ type: "text", text: `exported glTF to ${abs}` }] }; }
  );
  server.tool(
    { name: "export_minecraft_schematic", description: "Export model as simple JSON schematic", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportMinecraftSchematic(m, abs); return { content: [{ type: "text", text: `exported schematic JSON to ${abs}` }] }; }
  );

  // Importers
  server.tool(
    { name: "import_obj", description: "Import OBJ mesh and voxelize into a model", inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive() }).strict() },
    async (args: any) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); await importOBJ(model, abs); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );
  server.tool(
    { name: "import_svg", description: "Import basic SVG shapes (rect/circle) and extrude", inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), thickness: z.number().int().positive().optional() }).strict() },
    async (args: any) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); importSVG(model, abs, { thickness: args.thickness ?? 1 }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );

  // Animation
  const anims = new AnimationRegistry();
  server.tool(
    { name: "create_animation", description: "Create a new empty animation", inputSchema: z.object({}).strict() },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ id: anims.create() }) }] })
  );
  server.tool(
    { name: "set_animation_fps", description: "Set animation FPS and normalize frame durations", inputSchema: z.object({ animationId: z.string(), fps: z.number().int().positive() }).strict() },
    async (args: any) => { anims.setFps(args.animationId, args.fps); return { content: [{ type: "text", text: `set fps=${args.fps}` }] }; }
  );
  server.tool(
    { name: "set_animation_loop", description: "Set animation looping flag", inputSchema: z.object({ animationId: z.string(), loop: z.boolean() }).strict() },
    async (args: any) => { anims.setLoop(args.animationId, args.loop); return { content: [{ type: "text", text: `set loop=${args.loop}` }] }; }
  );
  server.tool(
    { name: "set_frame_duration", description: "Set specific frame duration in milliseconds", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0), durationMs: z.number().int().positive() }).strict() },
    async (args: any) => { anims.setFrameDuration(args.animationId, args.index, args.durationMs); return { content: [{ type: "text", text: `set frame ${args.index} duration=${args.durationMs}ms` }] }; }
  );
  server.tool(
    { name: "duplicate_frame", description: "Duplicate a frame at index", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0) }).strict() },
    async (args: any) => { anims.duplicateFrame(args.animationId, args.index); return { content: [{ type: "text", text: `duplicated frame ${args.index}` }] }; }
  );
  server.tool(
    { name: "remove_frame", description: "Remove a frame at index", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0) }).strict() },
    async (args: any) => { anims.removeFrame(args.animationId, args.index); return { content: [{ type: "text", text: `removed frame ${args.index}` }] }; }
  );
  server.tool(
    { name: "reorder_frame", description: "Move a frame from index to index", inputSchema: z.object({ animationId: z.string(), from: z.number().int().min(0), to: z.number().int().min(0) }).strict() },
    async (args: any) => { anims.reorder(args.animationId, args.from, args.to); return { content: [{ type: "text", text: `moved frame ${args.from} -> ${args.to}` }] }; }
  );
  server.tool(
    { name: "add_frame", description: "Add model as a frame to animation", inputSchema: z.object({ animationId: z.string(), id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); anims.addFrame(args.animationId, m); return { content: [{ type: "text", text: `added frame from model ${args.id}` }] }; }
  );
  server.tool(
    { name: "interpolate_frames", description: "Generate in-between frames between two frames of an animation", inputSchema: z.object({ animationId: z.string(), a: z.number().int(), b: z.number().int(), steps: z.number().int().positive() }).strict() },
    async (args: any) => { const data = anims.getData(args.animationId); const fa = data.frames[args.a]!.model; const fb = data.frames[args.b]!.model; const gen = interpolateFrames(fa, fb, args.steps); const dur = data.frames[args.a]!.durationMs; const mapped = gen.map(m=>({ model: m, durationMs: dur })); data.frames.splice(args.b, 0, ...mapped); return { content: [{ type: "text", text: `interpolated ${gen.length} frames` }] }; }
  );
  server.tool(
    { name: "export_animation_spritesheet", description: "Export animation frames to a spritesheet PNG", inputSchema: z.object({ animationId: z.string(), path: z.string() }).strict() },
    async (args: any) => { const frames = anims.getFrames(args.animationId); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportAnimationSpriteSheet(frames, abs); return { content: [{ type: "text", text: `exported spritesheet to ${abs}` }] }; }
  );
  server.tool(
    { name: "export_animation_frames", description: "Export animation frames as separate PNGs", inputSchema: z.object({ animationId: z.string(), folder: z.string(), projection: z.enum(["top","front","side","zmax","isometric"]).optional() }).strict() },
    async (args: any) => { const frames = anims.getFrames(args.animationId); const abs = path.isAbsolute(args.folder) ? args.folder : path.join(process.cwd(), args.folder); exportAnimationFrames(frames, abs, args.projection ?? "zmax"); return { content: [{ type: "text", text: `exported frames to ${abs}` }] }; }
  );
  server.tool(
    { name: "export_animation_gif", description: "Export animation as GIF (not supported in this build)", inputSchema: z.object({ animationId: z.string(), path: z.string() }).strict() },
    async (args: any) => { const frames = anims.getFrames(args.animationId); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportAnimationGIF(frames, abs); return { content: [{ type: "text", text: `exported gif to ${abs}` }] }; }
  );

  // Smart tools
  server.tool(
    { name: "auto_uv_color", description: "Color voxels by height (simple UV)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); autoUvColor(m); return { content: [{ type: "text", text: `auto uv colored ${args.id}` }] }; }
  );
  server.tool(
    { name: "detect_symmetry", description: "Detect dominant symmetry axis and score", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(detectSymmetry(m)) }] }; }
  );
  server.tool(
    { name: "make_symmetric", description: "Mirror model to enforce symmetry across an axis", inputSchema: z.object({ id: z.string(), axis: z.enum(["x","y","z"]) }).strict() },
    async (args: any) => { const m = registry.get(args.id); makeSymmetric(m, args.axis); return { content: [{ type: "text", text: `made symmetric ${args.id}` }] }; }
  );
  server.tool(
    { name: "simplify_model", description: "Downsample model for LOD", inputSchema: z.object({ id: z.string(), factor: z.number().int().min(1) }).strict() },
    async (args: any) => { const m = registry.get(args.id); simplifyModel(m, args.factor); return { content: [{ type: "text", text: `simplified ${args.id}` }] }; }
  );
  server.tool(
    { name: "voxelize_text", description: "Create 3D voxel text using 5x7 bitmap font", inputSchema: z.object({ id: z.string(), text: z.string(), i: z.number().int().min(1).max(255), thickness: z.number().int().positive().optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); voxelizeText(m, args.text, args.i, args.thickness ?? 1); return { content: [{ type: "text", text: `voxelized text into ${args.id}` }] }; }
  );

  // Analysis tools
  server.tool(
    { name: "measure_distance", description: "Measure distance between two points", inputSchema: z.object({ a: z.tuple([z.number(), z.number(), z.number()]), b: z.tuple([z.number(), z.number(), z.number()]) }).strict() },
    async (args: any) => ({ content: [{ type: "text", text: JSON.stringify({ distance: measureDistance(args.a, args.b) }) }] })
  );
  server.tool(
    { name: "get_surface_area", description: "Compute exposed surface area (voxel faces)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ area: getSurfaceArea(m) }) }] }; }
  );
  server.tool(
    { name: "get_volume", description: "Voxel count", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ volume: getVolume(m) }) }] }; }
  );
  server.tool(
    { name: "find_center", description: "Center of mass of voxels", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ center: findCenter(m) }) }] }; }
  );
  server.tool(
    { name: "get_dimensions", description: "Get model bounding box", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(getDimensions(m)) }] }; }
  );
  server.tool(
    { name: "count_colors", description: "Histogram of palette indices used", inputSchema: z.object({ id: z.string() }).strict() },
    async (args: any) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(countColors(m)) }] }; }
  );

  // Palette management
  server.tool(
    { name: "generate_palette", description: "Generate procedural palette (sunset/forest/neon/grayscale)", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); m.palette = generatePalette(args.name ?? "grayscale"); return { content: [{ type: "text", text: `palette generated for ${args.id}` }] }; }
  );
  server.tool(
    { name: "extract_palette_from_image", description: "Extract palette from image", inputSchema: z.object({ id: z.string(), path: z.string(), count: z.number().int().min(2).max(256).optional() }).strict() },
    async (args: any) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const pal = await extractPaletteFromImage(abs, args.count ?? 256); const m = registry.get(args.id); applyPaletteToModel(m, pal); return { content: [{ type: "text", text: `palette extracted to ${args.id}` }] }; }
  );
  server.tool(
    { name: "apply_palette_to_model", description: "Apply a named or extracted palette to a model", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).optional() }).strict() },
    async (args: any) => { const m = registry.get(args.id); if (args.name) m.palette = generatePalette(args.name); return { content: [{ type: "text", text: `palette applied to ${args.id}` }] }; }
  );
  server.tool(
    { name: "blend_palettes", description: "Blend current palette with a named palette", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).default("grayscale"), t: z.number().min(0).max(1) }).strict() },
    async (args: any) => { const m = registry.get(args.id); const cur = m.palette ?? generatePalette("grayscale"); const other = generatePalette(args.name); m.palette = blendPalettes(cur, other, args.t); return { content: [{ type: "text", text: `palette blended for ${args.id}` }] }; }
  );

  // Prompts (simple examples)
  server.registerPrompt("make_house", { description: "Create a house with floors" }, async (args: any) => {
    const sizeX = args.sizeX ?? 96, sizeY = args.sizeY ?? 96, sizeZ = args.sizeZ ?? 96;
    const floors = args.floors ?? 2;
    const { id, model } = registry.create(sizeX, sizeY, sizeZ);
    generateHouse(model, { floors, style: args.style ?? "modern", seed: args.seed ?? 0 });
    return { messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ id }) }] }] } as any;
  });

  server.registerPrompt("make_character", { description: "Create a humanoid character" }, async (args: any) => {
    const sizeX = args.sizeX ?? 96, sizeY = args.sizeY ?? 96, sizeZ = args.sizeZ ?? 96;
    const { id, model } = registry.create(sizeX, sizeY, sizeZ);
    generateCharacter(model, { style: args.style ?? "default", seed: args.seed ?? 0 });
    return { messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ id }) }] }] } as any;
  });

  // Resource templates (dynamic listings)
  server.registerResource("vox_files", { template: "magica:vox/{folder}" }, { description: "List .vox in folder under CWD" } as any, async (vars: any) => {
    const folder = vars.folder as string;
    const dir = path.join(process.cwd(), folder);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".vox")).map(f => path.join(dir, f)) : [];
    return { contents: [{ uri: `magica:vox/${folder}`, mimeType: "application/json", text: JSON.stringify(files) }] } as any;
  });

  // load_vox
  server.tool(
    {
      name: "load_vox",
      description: "Load a .vox file into memory (returns model id)",
      inputSchema: z.object({ path: z.string() }).strict(),
    },
    async (args: any) => {
      const p = args.path as string;
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      const m = loadVOX(abs);
      const { id } = registry.create(m.sizeX, m.sizeY, m.sizeZ);
      registry.set(id, m);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // set_magica_path
  server.tool(
    {
      name: "set_magica_path",
      description: "Set path to MagicaVoxel.exe",
      inputSchema: z.object({ exePath: z.string() }).strict(),
    },
    async (args: any) => {
      const { exePath } = args;
      config.setMagicaPath(exePath);
      return { content: [{ type: "text", text: `set MagicaVoxel: ${exePath}` }] };
    }
  );

  // open_in_magica
  server.tool(
    {
      name: "open_in_magica",
      description: "Open a .vox file in MagicaVoxel.exe",
      inputSchema: z.object({ path: z.string() }).strict(),
    },
    async (args: any) => {
      const exe = config.getMagicaPath();
      if (!exe) throw new Error("MagicaVoxel.exe not configured; call set_magica_path first or place it in default location.");
      const p = args.path as string;
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
      spawn(exe, [abs], { detached: true, stdio: "ignore" }).unref();
      return { content: [{ type: "text", text: `opened in MagicaVoxel: ${abs}` }] };
    }
  );

  // Resources: list vox samples and palettes
  const cwd = process.cwd();
  const parent = path.resolve(cwd, "..");
  const samplesCandidates = [
    path.join(cwd, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "vox"),
    path.join(parent, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "vox"),
  ];
  const palettesCandidates = [
    path.join(cwd, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "palette"),
    path.join(parent, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "palette"),
  ];
  const samplesDir = samplesCandidates.find((p) => fs.existsSync(p));
  const palettesDir = palettesCandidates.find((p) => fs.existsSync(p));

  server.resource({
    uri: "magica:samples",
    name: "MagicaVoxel Sample .vox Files",
    mimeType: "application/json",
    description: "List of bundled sample .vox files",
    get: async () => {
      const files = samplesDir
        ? fs
            .readdirSync(samplesDir)
            .filter((f) => f.toLowerCase().endsWith(".vox"))
            .map((f) => path.join(samplesDir, f))
        : [];
      return { contents: [{ uri: "magica:samples", mimeType: "application/json", text: JSON.stringify(files) }] };
    },
  });

  server.resource({
    uri: "magica:palettes",
    name: "MagicaVoxel Palettes",
    mimeType: "application/json",
    description: "List of bundled palette images",
    get: async () => {
      const files = palettesDir
        ? fs
            .readdirSync(palettesDir)
            .filter((f) => f.toLowerCase().endsWith(".png"))
            .map((f) => path.join(palettesDir, f))
        : [];
      return { contents: [{ uri: "magica:palettes", mimeType: "application/json", text: JSON.stringify(files) }] };
    },
  });
}

// ===== HELPER FUNCTIONS FOR CHARACTER DESCRIPTIONS =====

function getStaffDescription(type: string): string {
  const descriptions: Record<string, string> = {
    barman: "Bartender - White shirt, black vest, bow tie. Holding cocktail shaker. Expert at mixing drinks and listening to customers' problems.",
    chef: "Chef/Cook - Traditional white chef's uniform with tall toque hat. Holding frying pan. Master of Turkish cuisine and late-night snacks.",
    cleaner: "Cleaner - Blue uniform with cap and apron. Carrying mop. Keeps the place spotless despite the chaos.",
    konsomatris: "Hostess - Elegant dress with jewelry. High heels and styled hair. The heart and soul of the venue experience.",
    musician: "Musician - Casual dark clothes. Playing saz/guitar. Performs melancholic Turkish songs and arabesk classics.",
    security: "Bouncer - All black attire, sunglasses, earpiece. Muscular build with crossed arms. Maintains order with a stern look.",
    waiter: "Waiter - White shirt, black vest, bow tie. Carrying tray with drinks. Quick, professional, and always attentive.",
  };
  return descriptions[type] ?? "Staff member";
}

function getCustomerDescription(type: string): string {
  const descriptions: Record<string, string> = {
    regular: "Regular Customer - Ordinary person enjoying a night out. Simple clothes, relaxed attitude.",
    worker: "Worker Customer - Blue-collar worker with hard hat and overalls. Just finished a long shift, looking to unwind.",
    elite: "Elite Customer - Wealthy patron in expensive suit with gold accessories. Expects premium service.",
    nostalgic: "Nostalgic Customer - Old-timer with flat cap and cardigan. Misses the old Ankara days and classic Turkish music.",
    emotional: "Emotional Customer - Sad customer with tears and tissue. Drowning sorrows in rakı, has a story to tell.",
    young: "Young Customer - Trendy 20-something with modern haircut and smartphone. Here for the experience and Instagram.",
    bureaucrat: "Bureaucrat Customer - Government employee in gray suit with briefcase. After-work stress relief.",
    undercover: "Undercover Cop - Plain-clothes police with earpiece and concealed holster. Watching, always watching...",
    sapkali: "Şapkalı (Farmer) - Rural farmer who sold his land, wearing traditional flat cap. Spending his money freely.",
    gangster: "Gangster Customer - Mafioso type with dark suit, gold chain, and slicked hair. Commands respect and a corner table.",
    foreign: "Foreign Tourist - Tourist in Hawaiian shirt with camera. Fascinated by the authentic Turkish nightlife.",
    vip: "VIP Customer - Flashy high-roller with designer clothes and champagne. Gets the best table and special treatment.",
    behzatc: "Behzat Ç. Style - Leather jacket, stubble, cigarette, and rakı glass. Tired eyes that have seen too much. The iconic Ankara cop look.",
  };
  return descriptions[type] ?? "Customer";
}

import { McpServer, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MagicaConfig } from "./magicaConfig.js";
import { ModelRegistry, fillBox, fillSphere, fillCylinder, fillPyramid, fillCone, fillTorus, drawLine, setVoxels, translate, rotate90, booleanOp, scaleModel, cloneModel, clearRegion, copyRegion, pasteRegion, getModelInfo, cropToContent, centerModel, alignToGround, flipModel, rotateArbitrary } from "./model.js";
import { saveVOX, loadVOX } from "./vox.js";
import { generateHouse, generateCharacter, generateFromPrompt, imageToVoxel, generateVehicle, generateFurniture, generateWeapon, generateStructure, generateCreature, generateNature, generateCityBlock, generateVenueInterior, generateVenueCharacter, generateStaff, generateCustomer } from "./generators.js";
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
import { PNG } from "pngjs";
import { FilePolicy } from "./files.js";
import { registerSceneTools } from "./sceneTools.js";

// Clipboard for copy/paste operations


export function createTools(server: McpServer, registry: ModelRegistry, config: MagicaConfig) {
  const clipboard: { voxels: { x: number; y: number; z: number; i: number }[] } = { voxels: [] };
  const files = new FilePolicy();
  let pending: Promise<unknown> = Promise.resolve();
  const readOnly = new Set(["list_models", "get_model_info", "measure_distance", "get_surface_area", "get_volume", "find_center", "get_dimensions", "count_colors", "detect_symmetry", "render_model", "copy_region", "list_scenes", "get_scene_info"]);
  function registerTool<T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) {
    const { name, ...schema } = definition;
    server.registerTool(name, { ...schema, annotations: { readOnlyHint: readOnly.has(name), destructiveHint: !readOnly.has(name), openWorldHint: name === "open_in_magicavoxel" } }, async args => {
      const execute = async (): Promise<CallToolResult> => {
        try {
          const parameters = { ...args } as Record<string, unknown>;
          const limits: Record<string, number> = { sizeX: 256, sizeY: 256, sizeZ: 256, r: 256, majorR: 256, minorR: 256, height: 256, thickness: 256, amount: 256, floors: 32, iterations: 16, steps: 60, octaves: 8, fps: 120, durationMs: 600000 };
          for (const [key, value] of Object.entries(parameters)) {
            if (typeof value === "number" && (!Number.isFinite(value) || (limits[key] !== undefined && value > limits[key]!))) throw new Error(`${key} exceeds the supported limit`);
            if (typeof value === "string" && value.length > 4096) throw new Error(`${key} exceeds the string limit`);
            if (Array.isArray(value) && value.length > 262144) throw new Error(`${key} exceeds the array limit`);
            if (/^(x[01]?|y[01]?|z[01]?|c[xyz]|d[xyz]|offset[XYZ])$/.test(key) && typeof value === "number" && Math.abs(value) > 4096) throw new Error(`${key} exceeds the coordinate limit`);
            if (typeof value === "string" && ["path", "folder", "frontPath", "sidePath", "topPath"].includes(key)) {
              parameters[key] = name.startsWith("export_") || name.startsWith("save_")
                ? files.prepareOutput(value, key === "folder") : files.resolve(value, "read");
              if (key === "folder" && fs.readdirSync(parameters[key] as string).some(f => fs.lstatSync(path.join(parameters[key] as string, f)).isSymbolicLink())) throw new Error("Output directory contains symbolic links");
            }
          }
          const modelMutation = !readOnly.has(name) && !/^(export_|save_)/.test(name) && !name.includes("scene") && !name.includes("animation") && !["undo", "redo", "open_in_magicavoxel", "add_frame", "set_frame_duration", "duplicate_frame", "remove_frame", "reorder_frame", "interpolate_frames"].includes(name);
          return modelMutation
            ? await registry.transaction(() => handler(parameters as z.infer<z.ZodObject<T>>))
            : await handler(parameters as z.infer<z.ZodObject<T>>);
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      };
      const result = pending.then(execute, execute);
      pending = result.then(() => undefined, () => undefined);
      return result;
    });
  }
  registerTool({ name: "undo", description: "Undo the last model-registry edit (not file writes, scenes or animation edits)", inputSchema: z.object({}).strict() }, async () => ({ content: [{ type: "text", text: JSON.stringify({ changed: registry.undo() }) }] }));
  registerTool({ name: "redo", description: "Redo the last undone model-registry edit", inputSchema: z.object({}).strict() }, async () => ({ content: [{ type: "text", text: JSON.stringify({ changed: registry.redo() }) }] }));

  registerSceneTools(registerTool, registry);

  // create_model
  registerTool(
    {
      name: "create_model",
      description: "Create a new empty model with given dimensions.",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive() }).strict(),
    },
    async (args) => {
      const { sizeX, sizeY, sizeZ } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      return { content: [{ type: "text", text: JSON.stringify({ id, sizeX, sizeY, sizeZ }) }] };
    }
  );

  // image_to_voxel_colorized
  registerTool(
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
    async (args) => {
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
  registerTool(
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
    async (args) => {
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
  registerTool(
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
    async (args) => {
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
  registerTool(
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
    async (args) => {
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
  registerTool(
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
    async (args) => {
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
  registerTool(
    {
      name: "list_models",
      description: "List in-memory models",
      inputSchema: z.object({}).strict(),
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(registry.list()) }] })
  );

  // fill_box
  registerTool(
    {
      name: "fill_box",
      description: "Fill a box region with a palette index",
      inputSchema: z
        .object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int(), i: z.number().int().min(1).max(255) })
        .strict(),
    },
    async (args) => {
      const { id, x0, y0, z0, x1, y1, z1, i } = args;
      const m = registry.get(id);
      fillBox(m, x0, y0, z0, x1, y1, z1, i);
      return { content: [{ type: "text", text: `filled box in model ${id}` }] };
    }
  );

  // fill_sphere
  registerTool(
    {
      name: "fill_sphere",
      description: "Fill a sphere with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), cz: z.number().int(), r: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, cx, cy, cz, r, i } = args;
      const m = registry.get(id);
      fillSphere(m, cx, cy, cz, r, i);
      return { content: [{ type: "text", text: `filled sphere in model ${id}` }] };
    }
  );

  // fill_cylinder
  registerTool(
    {
      name: "fill_cylinder",
      description: "Fill a vertical cylinder with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), z0: z.number().int(), z1: z.number().int(), r: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, cx, cy, z0, z1, r, i } = args;
      const m = registry.get(id);
      fillCylinder(m, cx, cy, z0, z1, r, i);
      return { content: [{ type: "text", text: `filled cylinder in model ${id}` }] };
    }
  );

  // fill_pyramid
  registerTool(
    {
      name: "fill_pyramid",
      description: "Fill a pyramid shape with a palette index",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), height: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, x0, y0, z0, x1, y1, height, i } = args;
      const m = registry.get(id);
      fillPyramid(m, x0, y0, z0, x1, y1, height, i);
      return { content: [{ type: "text", text: `filled pyramid in model ${id}` }] };
    }
  );

  // fill_cone
  registerTool(
    {
      name: "fill_cone",
      description: "Fill a cone shape with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), z0: z.number().int(), r: z.number().int().positive(), height: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, cx, cy, z0, r, height, i } = args;
      const m = registry.get(id);
      fillCone(m, cx, cy, z0, r, height, i);
      return { content: [{ type: "text", text: `filled cone in model ${id}` }] };
    }
  );

  // fill_torus
  registerTool(
    {
      name: "fill_torus",
      description: "Fill a torus (donut) shape with a palette index",
      inputSchema: z.object({ id: z.string(), cx: z.number().int(), cy: z.number().int(), cz: z.number().int(), majorR: z.number().int().positive(), minorR: z.number().int().positive(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, cx, cy, cz, majorR, minorR, i } = args;
      const m = registry.get(id);
      fillTorus(m, cx, cy, cz, majorR, minorR, i);
      return { content: [{ type: "text", text: `filled torus in model ${id}` }] };
    }
  );

  // draw_line
  registerTool(
    {
      name: "draw_line",
      description: "Draw a 3D line between two points",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int(), i: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const { id, x0, y0, z0, x1, y1, z1, i } = args;
      const m = registry.get(id);
      drawLine(m, x0, y0, z0, x1, y1, z1, i);
      return { content: [{ type: "text", text: `drew line in model ${id}` }] };
    }
  );

  // set_voxels
  registerTool(
    {
      name: "set_voxels",
      description: "Add explicit voxels",
      inputSchema: z.object({ id: z.string(), voxels: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), i: z.number().int().min(1).max(255) }).strict()) }).strict(),
    },
    async (args) => {
      const { id, voxels } = args;
      const m = registry.get(id);
      setVoxels(m, voxels);
      return { content: [{ type: "text", text: `added ${voxels.length} voxels to model ${id}` }] };
    }
  );

  // transform_translate
  registerTool(
    {
      name: "transform_translate",
      description: "Translate a model in place",
      inputSchema: z.object({ id: z.string(), dx: z.number().int(), dy: z.number().int(), dz: z.number().int() }).strict(),
    },
    async (args) => {
      const { id, dx, dy, dz } = args;
      const m = registry.get(id);
      translate(m, dx, dy, dz);
      return { content: [{ type: "text", text: `translated model ${id}` }] };
    }
  );

  // transform_rotate90
  registerTool(
    {
      name: "transform_rotate90",
      description: "Rotate model by 90 degrees around an axis",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict(),
    },
    async (args) => {
      const { id, axis } = args;
      const m = registry.get(id);
      rotate90(m, axis);
      return { content: [{ type: "text", text: `rotated model ${id} around ${axis}` }] };
    }
  );

  // crop_to_content
  registerTool(
    { name: "crop_to_content", description: "Crop model size to its bounding content", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); cropToContent(m); return { content: [{ type: "text", text: `cropped ${args.id}` }] }; }
  );

  // center_model
  registerTool(
    { name: "center_model", description: "Center model content within its size", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); centerModel(m); return { content: [{ type: "text", text: `centered ${args.id}` }] }; }
  );

  // align_to_ground
  registerTool(
    { name: "align_to_ground", description: "Translate model so Z-min sits at 0", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); alignToGround(m); return { content: [{ type: "text", text: `aligned to ground ${args.id}` }] }; }
  );

  // flip_model
  registerTool(
    { name: "flip_model", description: "Flip model across an axis (no duplication)", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict() },
    async (args) => { const m = registry.get(args.id); flipModel(m, args.axis); return { content: [{ type: "text", text: `flipped ${args.id}` }] }; }
  );

  // rotate_arbitrary
  registerTool(
    { name: "rotate_arbitrary", description: "Rotate around axis by arbitrary degrees (voxel approx)", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), degrees: z.number() }).strict() },
    async (args) => { const m = registry.get(args.id); rotateArbitrary(m, args.axis, args.degrees); return { content: [{ type: "text", text: `rotated ${args.id}` }] }; }
  );

  // boolean_op
  registerTool(
    {
      name: "boolean_op",
      description: "Boolean op (union|intersect|difference) between two models; returns new model id",
      inputSchema: z.object({ a: z.string(), b: z.string(), op: z.enum(["union", "intersect", "difference"]) }).strict(),
    },
    async (args) => {
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
  registerTool(
    {
      name: "scale_model",
      description: "Scale a model by factors; returns new model id",
      inputSchema: z.object({ id: z.string(), scaleX: z.number().positive(), scaleY: z.number().positive(), scaleZ: z.number().positive() }).strict(),
    },
    async (args) => {
      const { id, scaleX, scaleY, scaleZ } = args;
      const m = registry.get(id);
      const out = scaleModel(m, scaleX, scaleY, scaleZ);
      const { id: newId } = registry.create(out.sizeX, out.sizeY, out.sizeZ);
      registry.set(newId, out);
      return { content: [{ type: "text", text: JSON.stringify({ id: newId, size: [out.sizeX, out.sizeY, out.sizeZ] }) }] };
    }
  );

  // clone_model
  registerTool(
    {
      name: "clone_model",
      description: "Clone a model; returns new model id",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const out = cloneModel(m);
      const { id: newId } = registry.create(out.sizeX, out.sizeY, out.sizeZ);
      registry.set(newId, out);
      return { content: [{ type: "text", text: JSON.stringify({ id: newId }) }] };
    }
  );

  // delete_model
  registerTool(
    {
      name: "delete_model",
      description: "Delete a model from memory",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args) => {
      registry.delete(args.id);
      return { content: [{ type: "text", text: `deleted model ${args.id}` }] };
    }
  );

  // clear_model
  registerTool(
    {
      name: "clear_model",
      description: "Clear all voxels from a model",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      m.voxels = [];
      return { content: [{ type: "text", text: `cleared model ${args.id}` }] };
    }
  );

  // clear_region
  registerTool(
    {
      name: "clear_region",
      description: "Clear voxels in a region",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int() }).strict(),
    },
    async (args) => {
      const { id, x0, y0, z0, x1, y1, z1 } = args;
      const m = registry.get(id);
      clearRegion(m, x0, y0, z0, x1, y1, z1);
      return { content: [{ type: "text", text: `cleared region in model ${id}` }] };
    }
  );

  // copy_region
  registerTool(
    {
      name: "copy_region",
      description: "Copy voxels in a region to clipboard",
      inputSchema: z.object({ id: z.string(), x0: z.number().int(), y0: z.number().int(), z0: z.number().int(), x1: z.number().int(), y1: z.number().int(), z1: z.number().int() }).strict(),
    },
    async (args) => {
      const { id, x0, y0, z0, x1, y1, z1 } = args;
      const m = registry.get(id);
      clipboard.voxels = copyRegion(m, x0, y0, z0, x1, y1, z1);
      return { content: [{ type: "text", text: `copied ${clipboard.voxels.length} voxels to clipboard` }] };
    }
  );

  // paste_region
  registerTool(
    {
      name: "paste_region",
      description: "Paste voxels from clipboard at offset",
      inputSchema: z.object({ id: z.string(), offsetX: z.number().int(), offsetY: z.number().int(), offsetZ: z.number().int() }).strict(),
    },
    async (args) => {
      const { id, offsetX, offsetY, offsetZ } = args;
      const m = registry.get(id);
      pasteRegion(m, clipboard.voxels, offsetX, offsetY, offsetZ);
      return { content: [{ type: "text", text: `pasted ${clipboard.voxels.length} voxels to model ${id}` }] };
    }
  );

  registerTool({
    name: "render_model",
    description: "Render a palette-colored model preview as a PNG image returned directly to the client",
    inputSchema: z.object({ id: z.string(), projection: z.enum(["top", "front", "side", "zmax", "isometric"]).default("isometric") }).strict()
  }, async ({ id, projection }) => {
    const png = renderFrameToPNG(registry.get(id), projection);
    return { content: [{ type: "image", mimeType: "image/png", data: PNG.sync.write(png).toString("base64") }] };
  });

  // get_model_info
  registerTool(
    {
      name: "get_model_info",
      description: "Get detailed info about a model (size, voxel count, bounding box, used colors)",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const info = getModelInfo(m);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    }
  );

  // save_vox
  registerTool(
    {
      name: "save_vox",
      description: "Save a model to a .vox file",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args) => {
      const { id, path: outPath } = args;
      const m = registry.get(id);
      const abs = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      saveVOX(abs, m);
      return { content: [{ type: "text", text: `saved ${abs}` }] };
    }
  );

  // set_model_palette
  registerTool(
    {
      name: "set_model_palette",
      description: "Set RGBA palette for a model (array of 256 uint32 RGBA values)",
      inputSchema: z.object({ id: z.string(), palette: z.array(z.number().int()).length(256) }).strict(),
    },
    async (args) => {
      const { id, palette } = args;
      const m = registry.get(id);
      m.palette = new Uint32Array(palette.map((v: number) => v >>> 0));
      return { content: [{ type: "text", text: `palette set for model ${id}` }] };
    }
  );

  // generate_house
  registerTool(
    {
      name: "generate_house",
      description: "Procedurally generate a house in a new model",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), floors: z.number().int().positive().optional(), style: z.string().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args) => {
      const { sizeX, sizeY, sizeZ, floors, style, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateHouse(model, { floors: floors ?? 2, style: style ?? "modern", seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_character
  registerTool(
    {
      name: "generate_character",
      description: "Procedurally generate a humanoid character in a new model",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), style: z.string().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args) => {
      const { sizeX, sizeY, sizeZ, style, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateCharacter(model, { style: style ?? "default", seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_from_prompt
  registerTool(
    {
      name: "generate_from_prompt",
      description: "Generate a model from a natural language prompt using built-in procedural patterns",
      inputSchema: z.object({ prompt: z.string(), sizeX: z.number().int().positive().optional(), sizeY: z.number().int().positive().optional(), sizeZ: z.number().int().positive().optional(), seed: z.number().int().optional() }).strict(),
    },
    async (args) => {
      const sizeX = args.sizeX ?? 96;
      const sizeY = args.sizeY ?? 96;
      const sizeZ = args.sizeZ ?? 96;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      await generateFromPrompt(model, args.prompt, { seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // image_to_voxel
  registerTool(
    {
      name: "image_to_voxel",
      description: "Convert an image to a voxel model (heightmap or extrude modes)",
      inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), mode: z.enum(["heightmap", "extrude"]).optional(), maxZ: z.number().int().positive().optional(), threshold: z.number().int().min(0).max(255).optional(), downscale: z.number().int().positive().optional() }).strict(),
    },
    async (args) => {
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
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateVehicle(model, { type: args.type, style: args.style ?? "lowpoly", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_structure
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateStructure(model, { type: args.type, style: args.style ?? "medieval", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // apply_pattern
  registerTool(
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
    async (args) => {
      const m = registry.get(args.id);
      applyPattern(m, args.pattern, args.colors, args.scale);
      return { content: [{ type: "text", text: `pattern applied to ${args.id}` }] };
    }
  );

  // apply_gradient
  registerTool(
    {
      name: "apply_gradient",
      description: "Apply 2-color gradient along an axis",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), i0: z.number().int().min(1).max(255), i1: z.number().int().min(1).max(255) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      applyGradient(m, args.axis, args.i0, args.i1);
      return { content: [{ type: "text", text: `gradient applied to ${args.id}` }] };
    }
  );

  // randomize_surface_color
  registerTool(
    {
      name: "randomize_surface_color",
      description: "Add subtle random color variation to surface voxels",
      inputSchema: z.object({ id: z.string(), delta: z.number().int().positive() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      randomizeSurfaceColor(m, Math.max(1, args.delta));
      return { content: [{ type: "text", text: `surface color randomized for ${args.id}` }] };
    }
  );

  // erode
  registerTool(
    { name: "erode", description: "Morphological erosion of model", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional() }).strict() },
    async (args) => { const m = registry.get(args.id); erode(m, args.iterations ?? 1); return { content: [{ type: "text", text: `eroded ${args.id}` }] }; }
  );

  // dilate
  registerTool(
    { name: "dilate", description: "Morphological dilation of model", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional(), i: z.number().int().min(1).max(255).optional() }).strict() },
    async (args) => { const m = registry.get(args.id); dilate(m, args.iterations ?? 1, args.i); return { content: [{ type: "text", text: `dilated ${args.id}` }] }; }
  );

  // outline
  registerTool(
    { name: "outline", description: "Keep only outer shell voxels (wireframe effect)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); outline(m); return { content: [{ type: "text", text: `outlined ${args.id}` }] }; }
  );

  // smooth_model
  registerTool(
    { name: "smooth_model", description: "Smooth model via majority filter", inputSchema: z.object({ id: z.string(), iterations: z.number().int().positive().optional() }).strict() },
    async (args) => { const m = registry.get(args.id); smoothModel(m, args.iterations ?? 1); return { content: [{ type: "text", text: `smoothed ${args.id}` }] }; }
  );

  // extrude_face
  registerTool(
    { name: "extrude_face", description: "Extrude exposed faces along an axis", inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]), amount: z.number().int().positive(), i: z.number().int().min(1).max(255).optional() }).strict() },
    async (args) => { const m = registry.get(args.id); extrudeFace(m, args.axis, args.amount, args.i); return { content: [{ type: "text", text: `extruded ${args.id}` }] }; }
  );

  // bevel_edges
  registerTool(
    { name: "bevel_edges", description: "Soften edges by removing sharp corner voxels", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); bevelEdges(m); return { content: [{ type: "text", text: `beveled ${args.id}` }] }; }
  );

  // add_detail_noise
  registerTool(
    { name: "add_detail_noise", description: "Add micro surface detail using noise displacement", inputSchema: z.object({ id: z.string(), scale: z.number().positive(), intensity: z.number().int().positive(), seed: z.number().int().optional() }).strict() },
    async (args) => { const m = registry.get(args.id); addDetailNoise(m, args.scale, args.intensity, args.seed ?? 0); return { content: [{ type: "text", text: `detail noise added to ${args.id}` }] }; }
  );

  // generate_furniture
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateFurniture(model, { type: args.type, style: args.style ?? "modern", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_weapon
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateWeapon(model, { type: args.type, style: args.style ?? "medieval", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_creature
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateCreature(model, { type: args.type, style: args.style ?? "cartoon", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // generate_nature
  registerTool(
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
    async (args) => {
      const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ);
      generateNature(model, { type: args.type, seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // Venue set: city block
  registerTool(
    { name: "generate_city_block", description: "Generate a city block layout (roads + buildings)", inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), roads: z.boolean().optional(), seed: z.number().int().optional() }).strict() },
    async (args) => { const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); generateCityBlock(model, { roads: args.roads ?? true, seed: args.seed ?? 0 }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );
  // Nightlife: venue interior
  registerTool(
    { name: "generate_venue_interior", description: "Generate a venue interior (stage, bar, tables, neon)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); generateVenueInterior(m, {}); return { content: [{ type: "text", text: `generated venue interior in ${args.id}` }] }; }
  );
  // Nightlife: character shell (legacy)
  registerTool(
    { name: "generate_venue_character", description: "Generate a themed humanoid character for a venue/nightclub scenario", inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), role: z.enum(["hostess","customer","waiter","cook","police_officer","gangster","detective"]) }).strict() },
    async (args) => { const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); generateVenueCharacter(model, { role: args.role }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );

  // ===== STAFF CHARACTER GENERATOR =====
  registerTool(
    {
      name: "generate_staff",
      description: "Generate detailed staff/employee character for a nightclub/venue. Types: bartender (bartender with shaker), chef (cook with hat & pan), cleaner (mop & uniform), hostess (elegant hostess), musician (with instrument), security (bouncer with sunglasses), waiter (tray & bow tie)",
      inputSchema: z.object({
        sizeX: z.number().int().positive().default(32),
        sizeY: z.number().int().positive().default(32),
        sizeZ: z.number().int().positive().default(48),
        type: z.enum(["bartender", "chef", "cleaner", "hostess", "musician", "security", "waiter"]),
        style: z.enum(["default", "fancy", "casual"]).optional(),
        seed: z.number().int().optional()
      }).strict(),
    },
    async (args) => {
      const { id, model } = registry.create(args.sizeX ?? 32, args.sizeY ?? 32, args.sizeZ ?? 48);
      generateStaff(model, { type: args.type, style: args.style ?? "default", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id, type: args.type, description: getStaffDescription(args.type) }) }] };
    }
  );

  // ===== CUSTOMER CHARACTER GENERATOR =====
  registerTool(
    {
      name: "generate_customer",
      description: "Generate detailed customer character for a nightclub/venue. Types: regular (normal customer), worker (blue-collar with hard hat), elite (rich in suit), retiree (older patron with flat cap), emotional (sad with tissue), young (trendy with phone), bureaucrat (government employee with briefcase), undercover (plain-clothes cop with earpiece), farmer (rural patron with flat cap), gangster (mafioso with gold chain), foreign (tourist with camera), vip (flashy with champagne), detective (leather jacket, stubble, whiskey glass)",
      inputSchema: z.object({
        sizeX: z.number().int().positive().default(32),
        sizeY: z.number().int().positive().default(32),
        sizeZ: z.number().int().positive().default(48),
        type: z.enum(["regular", "worker", "elite", "retiree", "emotional", "young", "bureaucrat", "undercover", "farmer", "gangster", "foreign", "vip", "detective"]),
        pose: z.enum(["standing", "sitting", "drinking"]).optional(),
        seed: z.number().int().optional()
      }).strict(),
    },
    async (args) => {
      const { id, model } = registry.create(args.sizeX ?? 32, args.sizeY ?? 32, args.sizeZ ?? 48);
      generateCustomer(model, { type: args.type, pose: args.pose ?? "standing", seed: args.seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id, type: args.type, pose: args.pose ?? "standing", description: getCustomerDescription(args.type) }) }] };
    }
  );

  // deduplicate_voxels
  registerTool(
    {
      name: "deduplicate_voxels",
      description: "Remove duplicate voxels at the same coordinates",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const before = m.voxels.length;
      deduplicateVoxels(m);
      const after = m.voxels.length;
      return { content: [{ type: "text", text: `deduplicated: ${before} -> ${after}` }] };
    }
  );

  // mirror_model
  registerTool(
    {
      name: "mirror_model",
      description: "Mirror model across an axis and merge",
      inputSchema: z.object({ id: z.string(), axis: z.enum(["x", "y", "z"]) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      mirror(m, args.axis);
      return { content: [{ type: "text", text: `mirrored ${args.id} on ${args.axis}` }] };
    }
  );

  // hollow_model
  registerTool(
    {
      name: "hollow_model",
      description: "Make a hollow shell by removing interior voxels",
      inputSchema: z.object({ id: z.string(), thickness: z.number().int().min(1).max(8).default(1) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      hollow(m, args.thickness ?? 1);
      return { content: [{ type: "text", text: `hollowed ${args.id} thickness ${args.thickness ?? 1}` }] };
    }
  );

  // flood_fill
  registerTool(
    {
      name: "flood_fill",
      description: "Flood fill contiguous region from a seed coordinate",
      inputSchema: z.object({ id: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(), targetIndex: z.number().int().min(0).max(255), newIndex: z.number().int().min(0).max(255) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const changed = floodFill(m, args.x, args.y, args.z, args.targetIndex, args.newIndex);
      return { content: [{ type: "text", text: `flood filled ${changed} voxels in ${args.id}` }] };
    }
  );

  // palette tools
  registerTool(
    {
      name: "set_palette_index",
      description: "Set RGBA value of a palette index",
      inputSchema: z.object({ id: z.string(), index: z.number().int().min(0).max(255), rgba: z.number().int() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      setPaletteIndex(m, args.index, args.rgba);
      return { content: [{ type: "text", text: `set palette[${args.index}]` }] };
    }
  );

  registerTool(
    {
      name: "load_palette_from_png",
      description: "Load first 256 pixels of a PNG into palette",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      loadPaletteFromPng(m, abs);
      return { content: [{ type: "text", text: `palette loaded from ${abs}` }] };
    }
  );

  registerTool(
    {
      name: "save_palette_to_png",
      description: "Save palette to 16x16 PNG",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      savePaletteToPng(m, abs);
      return { content: [{ type: "text", text: `palette saved to ${abs}` }] };
    }
  );

  // Export tools
  registerTool(
    {
      name: "export_obj",
      description: "Export model to OBJ mesh format",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      exportOBJ(m, abs);
      return { content: [{ type: "text", text: `exported OBJ to ${abs}` }] };
    }
  );

  registerTool(
    {
      name: "export_ply",
      description: "Export model to PLY point cloud format",
      inputSchema: z.object({ id: z.string(), path: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      exportPLY(m, abs);
      return { content: [{ type: "text", text: `exported PLY to ${abs}` }] };
    }
  );

  registerTool(
    {
      name: "export_slices",
      description: "Export model as PNG slices (one per Z layer)",
      inputSchema: z.object({ id: z.string(), folder: z.string() }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const abs = path.isAbsolute(args.folder) ? args.folder : path.join(process.cwd(), args.folder);
      exportSlices(m, abs);
      return { content: [{ type: "text", text: `exported slices to ${abs}` }] };
    }
  );

  // Terrain and procedural tools
  registerTool(
    {
      name: "generate_terrain",
      description: "Generate procedural terrain using fractal noise",
      inputSchema: z.object({ sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), octaves: z.number().int().min(1).max(8).default(4), persistence: z.number().min(0).max(1).default(0.5), scale: z.number().positive().default(20), seed: z.number().int().default(0) }).strict(),
    },
    async (args) => {
      const { sizeX, sizeY, sizeZ, octaves, persistence, scale, seed } = args;
      const { id, model } = registry.create(sizeX, sizeY, sizeZ);
      generateTerrain(model, { octaves: octaves ?? 4, persistence: persistence ?? 0.5, scale: scale ?? 20, seed: seed ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  registerTool(
    {
      name: "apply_noise",
      description: "Apply noise displacement to existing voxels",
      inputSchema: z.object({ id: z.string(), scale: z.number().positive().default(10), intensity: z.number().positive().default(5), seed: z.number().int().default(0) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      applyNoise(m, args.scale ?? 10, args.intensity ?? 5, args.seed ?? 0);
      return { content: [{ type: "text", text: `applied noise to ${args.id}` }] };
    }
  );

  registerTool(
    {
      name: "generate_tree",
      description: "Generate a tree at specified position",
      inputSchema: z.object({ id: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(), style: z.enum(["oak", "pine", "palm"]).default("oak"), seed: z.number().int().default(0) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      generateTree(m, args.x, args.y, args.z, args.style ?? "oak", args.seed ?? 0);
      return { content: [{ type: "text", text: `generated ${args.style ?? "oak"} tree in ${args.id}` }] };
    }
  );

  registerTool(
    {
      name: "replace_color",
      description: "Replace all voxels of one color with another",
      inputSchema: z.object({ id: z.string(), oldIndex: z.number().int().min(0).max(255), newIndex: z.number().int().min(0).max(255) }).strict(),
    },
    async (args) => {
      const m = registry.get(args.id);
      const count = replaceColor(m, args.oldIndex, args.newIndex);
      return { content: [{ type: "text", text: `replaced ${count} voxels in ${args.id}` }] };
    }
  );

  // Export extensions
  registerTool(
    { name: "export_stl", description: "Export model as ASCII STL", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportSTL(m, abs); return { content: [{ type: "text", text: `exported STL to ${abs}` }] }; }
  );
  registerTool(
    { name: "export_gltf", description: "Export model as minimal glTF 2.0", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportGLTF(m, abs); return { content: [{ type: "text", text: `exported glTF to ${abs}` }] }; }
  );
  registerTool(
    { name: "export_minecraft_schematic", description: "Export model as simple JSON schematic", inputSchema: z.object({ id: z.string(), path: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportMinecraftSchematic(m, abs); return { content: [{ type: "text", text: `exported schematic JSON to ${abs}` }] }; }
  );

  // Importers
  registerTool(
    { name: "import_obj", description: "Import OBJ mesh and voxelize into a model", inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive() }).strict() },
    async (args) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); await importOBJ(model, abs); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );
  registerTool(
    { name: "import_svg", description: "Import basic SVG shapes (rect/circle) and extrude", inputSchema: z.object({ path: z.string(), sizeX: z.number().int().positive(), sizeY: z.number().int().positive(), sizeZ: z.number().int().positive(), thickness: z.number().int().positive().optional() }).strict() },
    async (args) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const { id, model } = registry.create(args.sizeX, args.sizeY, args.sizeZ); importSVG(model, abs, { thickness: args.thickness ?? 1 }); return { content: [{ type: "text", text: JSON.stringify({ id }) }] }; }
  );

  // Animation
  const anims = new AnimationRegistry();
  registerTool(
    { name: "create_animation", description: "Create a new empty animation", inputSchema: z.object({}).strict() },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ id: anims.create() }) }] })
  );
  registerTool(
    { name: "set_animation_fps", description: "Set animation FPS and normalize frame durations", inputSchema: z.object({ animationId: z.string(), fps: z.number().int().positive() }).strict() },
    async (args) => { anims.setFps(args.animationId, args.fps); return { content: [{ type: "text", text: `set fps=${args.fps}` }] }; }
  );
  registerTool(
    { name: "set_animation_loop", description: "Set animation looping flag", inputSchema: z.object({ animationId: z.string(), loop: z.boolean() }).strict() },
    async (args) => { anims.setLoop(args.animationId, args.loop); return { content: [{ type: "text", text: `set loop=${args.loop}` }] }; }
  );
  registerTool(
    { name: "set_frame_duration", description: "Set specific frame duration in milliseconds", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0), durationMs: z.number().int().positive() }).strict() },
    async (args) => { anims.setFrameDuration(args.animationId, args.index, args.durationMs); return { content: [{ type: "text", text: `set frame ${args.index} duration=${args.durationMs}ms` }] }; }
  );
  registerTool(
    { name: "duplicate_frame", description: "Duplicate a frame at index", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0) }).strict() },
    async (args) => { anims.duplicateFrame(args.animationId, args.index); return { content: [{ type: "text", text: `duplicated frame ${args.index}` }] }; }
  );
  registerTool(
    { name: "remove_frame", description: "Remove a frame at index", inputSchema: z.object({ animationId: z.string(), index: z.number().int().min(0) }).strict() },
    async (args) => { anims.removeFrame(args.animationId, args.index); return { content: [{ type: "text", text: `removed frame ${args.index}` }] }; }
  );
  registerTool(
    { name: "reorder_frame", description: "Move a frame from index to index", inputSchema: z.object({ animationId: z.string(), from: z.number().int().min(0), to: z.number().int().min(0) }).strict() },
    async (args) => { anims.reorder(args.animationId, args.from, args.to); return { content: [{ type: "text", text: `moved frame ${args.from} -> ${args.to}` }] }; }
  );
  registerTool(
    { name: "add_frame", description: "Add model as a frame to animation", inputSchema: z.object({ animationId: z.string(), id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); anims.addFrame(args.animationId, m); return { content: [{ type: "text", text: `added frame from model ${args.id}` }] }; }
  );
  registerTool(
    { name: "interpolate_frames", description: "Generate in-between frames between two frames of an animation", inputSchema: z.object({ animationId: z.string(), a: z.number().int(), b: z.number().int(), steps: z.number().int().positive() }).strict() },
    async (args) => { const data = anims.getData(args.animationId); const fa = data.frames[args.a]!.model; const fb = data.frames[args.b]!.model; const gen = interpolateFrames(fa, fb, args.steps); const dur = data.frames[args.a]!.durationMs; const mapped = gen.map(m=>({ model: m, durationMs: dur })); data.frames.splice(args.b, 0, ...mapped); return { content: [{ type: "text", text: `interpolated ${gen.length} frames` }] }; }
  );
  registerTool(
    { name: "export_animation_spritesheet", description: "Export animation frames to a spritesheet PNG", inputSchema: z.object({ animationId: z.string(), path: z.string() }).strict() },
    async (args) => { const frames = anims.getFrames(args.animationId); const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); exportAnimationSpriteSheet(frames, abs); return { content: [{ type: "text", text: `exported spritesheet to ${abs}` }] }; }
  );
  registerTool(
    { name: "export_animation_frames", description: "Export animation frames as separate PNGs", inputSchema: z.object({ animationId: z.string(), folder: z.string(), projection: z.enum(["top","front","side","zmax","isometric"]).optional() }).strict() },
    async (args) => { const frames = anims.getFrames(args.animationId); const abs = path.isAbsolute(args.folder) ? args.folder : path.join(process.cwd(), args.folder); exportAnimationFrames(frames, abs, args.projection ?? "zmax"); return { content: [{ type: "text", text: `exported frames to ${abs}` }] }; }
  );
  registerTool(
    { name: "export_animation_gif", description: "Export an animation as a looping or one-shot GIF using frame durations and palette colors", inputSchema: z.object({ animationId: z.string(), path: z.string(), projection: z.enum(["top","front","side","zmax","isometric"]).optional() }).strict() },
    async (args) => { const data = anims.getData(args.animationId); exportAnimationGIF(data, args.path, args.projection ?? "isometric"); return { content: [{ type: "text", text: `exported GIF to ${args.path}` }] }; }
  );

  // Smart tools
  registerTool(
    { name: "auto_uv_color", description: "Color voxels by height (simple UV)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); autoUvColor(m); return { content: [{ type: "text", text: `auto uv colored ${args.id}` }] }; }
  );
  registerTool(
    { name: "detect_symmetry", description: "Detect dominant symmetry axis and score", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(detectSymmetry(m)) }] }; }
  );
  registerTool(
    { name: "make_symmetric", description: "Mirror model to enforce symmetry across an axis", inputSchema: z.object({ id: z.string(), axis: z.enum(["x","y","z"]) }).strict() },
    async (args) => { const m = registry.get(args.id); makeSymmetric(m, args.axis); return { content: [{ type: "text", text: `made symmetric ${args.id}` }] }; }
  );
  registerTool(
    { name: "simplify_model", description: "Downsample model for LOD", inputSchema: z.object({ id: z.string(), factor: z.number().int().min(1) }).strict() },
    async (args) => { const m = registry.get(args.id); simplifyModel(m, args.factor); return { content: [{ type: "text", text: `simplified ${args.id}` }] }; }
  );
  registerTool(
    { name: "voxelize_text", description: "Create 3D voxel text using 5x7 bitmap font", inputSchema: z.object({ id: z.string(), text: z.string(), i: z.number().int().min(1).max(255), thickness: z.number().int().positive().optional() }).strict() },
    async (args) => { const m = registry.get(args.id); voxelizeText(m, args.text, args.i, args.thickness ?? 1); return { content: [{ type: "text", text: `voxelized text into ${args.id}` }] }; }
  );

  // Analysis tools
  registerTool(
    { name: "measure_distance", description: "Measure distance between two points", inputSchema: z.object({ a: z.tuple([z.number(), z.number(), z.number()]), b: z.tuple([z.number(), z.number(), z.number()]) }).strict() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify({ distance: measureDistance(args.a, args.b) }) }] })
  );
  registerTool(
    { name: "get_surface_area", description: "Compute exposed surface area (voxel faces)", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ area: getSurfaceArea(m) }) }] }; }
  );
  registerTool(
    { name: "get_volume", description: "Voxel count", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ volume: getVolume(m) }) }] }; }
  );
  registerTool(
    { name: "find_center", description: "Center of mass of voxels", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify({ center: findCenter(m) }) }] }; }
  );
  registerTool(
    { name: "get_dimensions", description: "Get model bounding box", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(getDimensions(m)) }] }; }
  );
  registerTool(
    { name: "count_colors", description: "Histogram of palette indices used", inputSchema: z.object({ id: z.string() }).strict() },
    async (args) => { const m = registry.get(args.id); return { content: [{ type: "text", text: JSON.stringify(countColors(m)) }] }; }
  );

  // Palette management
  registerTool(
    { name: "generate_palette", description: "Generate procedural palette (sunset/forest/neon/grayscale)", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).optional() }).strict() },
    async (args) => { const m = registry.get(args.id); m.palette = generatePalette(args.name ?? "grayscale"); return { content: [{ type: "text", text: `palette generated for ${args.id}` }] }; }
  );
  registerTool(
    { name: "extract_palette_from_image", description: "Extract palette from image", inputSchema: z.object({ id: z.string(), path: z.string(), count: z.number().int().min(2).max(256).optional() }).strict() },
    async (args) => { const abs = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path); const pal = await extractPaletteFromImage(abs, args.count ?? 256); const m = registry.get(args.id); applyPaletteToModel(m, pal); return { content: [{ type: "text", text: `palette extracted to ${args.id}` }] }; }
  );
  registerTool(
    { name: "apply_palette_to_model", description: "Apply a named or extracted palette to a model", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).optional() }).strict() },
    async (args) => { const m = registry.get(args.id); if (args.name) m.palette = generatePalette(args.name); return { content: [{ type: "text", text: `palette applied to ${args.id}` }] }; }
  );
  registerTool(
    { name: "blend_palettes", description: "Blend current palette with a named palette", inputSchema: z.object({ id: z.string(), name: z.enum(["sunset", "forest", "neon", "grayscale"]).default("grayscale"), t: z.number().min(0).max(1) }).strict() },
    async (args) => { const m = registry.get(args.id); const cur = m.palette ?? generatePalette("grayscale"); const other = generatePalette(args.name); m.palette = blendPalettes(cur, other, args.t); return { content: [{ type: "text", text: `palette blended for ${args.id}` }] }; }
  );

  server.registerPrompt("make_house", {
    description: "Plan a procedural house without modifying the workspace",
    argsSchema: z.object({ size: z.string().optional(), floors: z.string().optional(), style: z.string().optional() })
  }, async ({ size = "64", floors = "2", style = "modern" }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Create a ${size}x${size}x${size} voxel house with ${floors} floors in ${style} style using generate_house. Inspect it with render_model before saving.` } }]
  }));
  server.registerPrompt("make_character", {
    description: "Plan a procedural character without modifying the workspace",
    argsSchema: z.object({ size: z.string().optional(), style: z.string().optional() })
  }, async ({ size = "64", style = "default" }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Create a ${size}x${size}x${size} voxel character in ${style} style using generate_character, then inspect it with render_model.` } }]
  }));
  server.registerResource("models", "magicavoxel:models", { description: "Models in the current session", mimeType: "application/json" }, async uri => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(registry.list()) }]
  }));
  server.registerResource("vox_files", new ResourceTemplate("magicavoxel:vox/{folder}", { list: undefined }), {
    description: "List .vox files in a workspace subfolder", mimeType: "application/json"
  }, async (uri, variables) => {
    const folder = String(variables.folder ?? ".");
    const dir = files.resolve(folder, "directory");
    const entries = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".vox"));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(entries) }] };
  });

  // load_vox
  registerTool(
    {
      name: "load_vox",
      description: "Load a .vox file into memory (returns model id)",
      inputSchema: z.object({ path: z.string() }).strict(),
    },
    async (args) => {
      const p = args.path as string;
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      const m = loadVOX(abs);
      const { id } = registry.create(m.sizeX, m.sizeY, m.sizeZ);
      registry.set(id, m);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
  );

  // open_in_magicavoxel
  registerTool(
    {
      name: "open_in_magicavoxel",
      description: "Open a .vox file in MagicaVoxel.exe",
      inputSchema: z.object({ path: z.string() }).strict(),
    },
    async (args) => {
      const exe = config.getMagicaPath();
      if (!exe) throw new Error("MagicaVoxel executable not configured; set the MAGICAVOXEL_PATH environment variable.");
      const p = args.path as string;
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(exe, [abs], { detached: true, stdio: "ignore", shell: false });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      return { content: [{ type: "text", text: `opened in MagicaVoxel: ${abs}` }] };
    }
  );

  for (const [name, uri, folder, extension] of [
    ["samples", "magicavoxel:samples", "vox", ".vox"],
    ["palettes", "magicavoxel:palettes", "palette", ".png"]
  ] as const) {
    server.registerResource(name, uri, { mimeType: "application/json", description: `Available ${name} in workspace/${folder}` }, async resourceUri => {
      const candidate = path.join(files.root, folder);
      const entries = fs.existsSync(candidate) ? fs.readdirSync(files.resolve(folder, "directory")).filter(f => f.toLowerCase().endsWith(extension)) : [];
      return { contents: [{ uri: resourceUri.href, mimeType: "application/json", text: JSON.stringify(entries) }] };
    });
  }
}

// ===== HELPER FUNCTIONS FOR CHARACTER DESCRIPTIONS =====

function getStaffDescription(type: string): string {
  const descriptions: Record<string, string> = {
    bartender: "Bartender - White shirt, black vest, bow tie. Holding a cocktail shaker.",
    chef: "Chef - White chef's uniform with tall toque hat. Holding a frying pan.",
    cleaner: "Cleaner - Blue uniform with cap and apron. Carrying a mop.",
    hostess: "Hostess - Elegant dress with jewelry, high heels and styled hair.",
    musician: "Musician - Casual dark clothes. Playing a guitar.",
    security: "Security guard - All black attire, sunglasses, earpiece. Muscular build with crossed arms.",
    waiter: "Waiter - White shirt, black vest, bow tie. Carrying a tray with drinks.",
  };
  return descriptions[type] ?? "Staff member";
}

function getCustomerDescription(type: string): string {
  const descriptions: Record<string, string> = {
    regular: "Regular customer - Ordinary person enjoying a night out. Simple clothes, relaxed attitude.",
    worker: "Worker - Blue-collar worker with hard hat and overalls, just finished a long shift.",
    elite: "Elite customer - Wealthy patron in an expensive suit with gold accessories.",
    retiree: "Retiree - Older patron with flat cap and cardigan.",
    emotional: "Emotional customer - Sad patron with tears and a tissue.",
    young: "Young customer - Trendy twenty-something with a modern haircut and smartphone.",
    bureaucrat: "Bureaucrat - Office employee in a gray suit with a briefcase.",
    undercover: "Undercover officer - Plain clothes with a discreet earpiece.",
    farmer: "Farmer - Rural patron wearing a flat cap and simple clothes.",
    gangster: "Gangster - Dark suit, gold chain and slicked hair.",
    foreign: "Tourist - Hawaiian shirt with a camera.",
    vip: "VIP customer - Flashy high-roller with designer clothes and champagne.",
    detective: "Detective - Leather jacket, stubble and a whiskey glass. Tired eyes.",
  };
  return descriptions[type] ?? "Customer";
}

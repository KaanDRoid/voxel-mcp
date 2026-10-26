import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ModelRegistry, MAX_VOXELS, mutateModel } from "./model.js";
import { FilePolicy } from "./files.js";
import { MagicaConfig } from "./magicaConfig.js";
import { compileXs, runXsOnVolume } from "./xsEval.js";
import { installShaderDir, listShaders, readInstalledShader, readLimited, validateXsSource, XS_MAX_BYTES, BUILTIN_ARGS, BUILTIN_FUNCTIONS } from "./xsShader.js";
import { generateXsTemplate, XS_TEMPLATE_KINDS } from "./xsTemplates.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Tools that never change state; the tool wrapper marks them read-only. */
export const XS_READ_ONLY_TOOLS = ["list_xs_shaders", "read_xs_shader", "validate_xs_shader", "generate_xs_shader_template"];

const pathField = z.string().optional().describe("Shader text file inside the workspace");
const nameField = z.string().optional().describe("Name of a shader in the MagicaVoxel shader folder (without .txt)");
const sourceField = z.string().max(XS_MAX_BYTES).optional().describe("Shader text given inline");

function isInside(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function registerXsTools(register: RegisterTool, registry: ModelRegistry, config: MagicaConfig, files: FilePolicy): void {
  const installDir = () => installShaderDir(config.getMagicaPath());
  const load = (a: { path?: string | undefined; name?: string | undefined; source?: string | undefined }): string => {
    const given = [a.path, a.name, a.source].filter(v => v !== undefined).length;
    if (given !== 1) throw new Error("Provide exactly one of path, name or source");
    if (a.source !== undefined) return a.source;
    if (a.path !== undefined) return readLimited(a.path); // already resolved by the workspace policy
    const dir = installDir();
    if (!dir) throw new Error("MagicaVoxel shader folder not found; set MAGICAVOXEL_HOME or MAGICAVOXEL_PATH");
    return readInstalledShader(dir, a.name!);
  };

  register({
    name: "list_xs_shaders",
    description: "List xs shaders (.txt with an xs header) in a workspace folder and in the MagicaVoxel shader folder (read only)",
    inputSchema: z.object({ location: z.enum(["workspace", "install", "both"]).optional(), subdir: z.string().max(1024).optional().describe("Workspace sub-folder (default: workspace root)") }).strict(),
  }, async ({ location = "both", subdir }) => {
    const shaders = [];
    const notes: string[] = [];
    if (location !== "install") shaders.push(...listShaders(files.resolve(subdir ?? ".", "directory"), "workspace"));
    if (location !== "workspace") {
      const dir = installDir();
      if (dir) shaders.push(...listShaders(dir, "install"));
      else notes.push("MagicaVoxel shader folder not found (set MAGICAVOXEL_HOME or MAGICAVOXEL_PATH)");
    }
    return text({ count: shaders.length, shaders, notes });
  });

  register({
    name: "read_xs_shader",
    description: "Read an xs shader (workspace path or installed name) and return its text with the parsed header, built-in arguments and functions",
    inputSchema: z.object({ path: pathField, name: nameField }).strict(),
  }, async a => {
    const source = load(a);
    const v = validateXsSource(source);
    return text({ source, header: v.header, valid: v.valid, builtinArgs: BUILTIN_ARGS, builtinFunctions: BUILTIN_FUNCTIONS });
  });

  register({
    name: "validate_xs_shader",
    description: "Check xs shader structure: header fields, arg definitions, map(vec3) signature, and whether the built-in evaluator can run it. No full GLSL compile.",
    inputSchema: z.object({ path: pathField, name: nameField, source: sourceField }).strict(),
  }, async a => {
    const v = validateXsSource(load(a));
    return text({ valid: v.valid, errors: v.errors, warnings: v.warnings, evaluable: v.evaluable, evaluableReason: v.evaluableReason ?? null, args: v.header.args, author: v.header.author ?? null });
  });

  register({
    name: "write_xs_shader",
    description: "Validate and write an xs shader text file inside the workspace (never into the MagicaVoxel folder)",
    inputSchema: z.object({ path: z.string(), source: z.string().max(XS_MAX_BYTES), overwrite: z.boolean().optional() }).strict(),
  }, async ({ path: target, source, overwrite }) => {
    if (!/\.txt$/i.test(target)) throw new Error("Shader file name must end with .txt");
    const dir = installDir();
    if (dir && isInside(dir, path.join(fs.realpathSync(path.dirname(target)), path.basename(target)))) throw new Error("Writing into the MagicaVoxel shader folder is not allowed");
    const v = validateXsSource(source);
    if (!v.valid) throw new Error(`Shader is not valid: ${v.errors.join("; ")}`);
    if (fs.existsSync(target) && !overwrite) throw new Error("File already exists; pass overwrite: true to replace it");
    fs.writeFileSync(target, source, "utf8");
    return text({ path: target, bytes: Buffer.byteLength(source), warnings: v.warnings, evaluable: v.evaluable });
  });

  register({
    name: "generate_xs_shader_template",
    description: "Return xs shader text for a common shape or pattern that can be saved with write_xs_shader or pasted into MagicaVoxel",
    inputSchema: z.object({ kind: z.enum(XS_TEMPLATE_KINDS), author: z.string().max(64).optional() }).strict(),
  }, async ({ kind, author }) => text({ kind, source: generateXsTemplate(kind, author) }));

  register({
    name: "run_xs_shader",
    description: "Run an xs shader over a whole model with the built-in sandboxed evaluator (documented GLSL subset, step and time limits). Undoable.",
    inputSchema: z.object({
      id: z.string(), path: pathField, name: nameField, source: sourceField,
      args: z.record(z.string().max(64), z.number()).optional().describe("Values for the shader's declared args; missing ones use header defaults"),
      colorIndex: z.number().int().min(1).max(255).optional(),
      selections: z.array(z.number().int().min(1).max(255)).max(255).optional().describe("Selected palette indices for color_sel() (default: [colorIndex])"),
      mode: z.enum(["replace", "add"]).optional().describe("replace: the shader result is the new model; add: only non-zero results overwrite"),
      timeLimitMs: z.number().int().min(100).max(120000).optional(),
    }).strict(),
  }, async a => {
    const model = registry.get(a.id);
    const source = load(a);
    const v = validateXsSource(source);
    if (!v.valid) throw new Error(`Shader is not valid: ${v.errors.join("; ")}`);
    const values: Record<string, number> = {};
    for (const arg of v.header.args) values[arg.var] = arg.value;
    for (const [k, val] of Object.entries(a.args ?? {})) {
      const def = v.header.args.find(x => x.var === k);
      if (!def) throw new Error(`Unknown shader arg '${k}'`);
      if (val < def.range[0] || val > def.range[1]) throw new Error(`Arg '${k}' must be within ${def.range[0]}..${def.range[1]}`);
      values[k] = val;
    }
    const colorIndex = a.colorIndex ?? 1;
    const program = compileXs(source, v.header.args.map(x => x.var));
    const result = runXsOnVolume(program, model, { args: values, colorIndex, selections: a.selections ?? [colorIndex], mode: a.mode ?? "replace", timeLimitMs: a.timeLimitMs ?? 20000 }, MAX_VOXELS);
    mutateModel(model, draft => { draft.voxels = result.voxels; });
    return text({ id: a.id, voxels: result.filled, changed: result.changed, elapsedMs: result.elapsedMs });
  });
}

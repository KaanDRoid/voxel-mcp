import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { FilePolicy } from "./files.js";
import type { MagicaConfig } from "./magicaConfig.js";
import { installReadRoots, tryResolveInstall, type MagicaInstall } from "./magicaInstall.js";
import { readConfigFile } from "./magicaConfigFile.js";
import { decodeVOXScene } from "./scene.js";
import { loadVOX } from "./vox.js";
import type { ModelRegistry } from "./model.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;

/** Tools that never change state; the shared registration wrapper marks exactly these as read-only. */
export const INSTALL_READ_ONLY_TOOLS = ["get_magicavoxel_info", "list_magicavoxel_samples", "list_magicavoxel_palettes", "list_magicavoxel_shaders", "list_magicavoxel_ibl"];

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const SAMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-]*(?:\/[A-Za-z0-9][A-Za-z0-9 _.\-]*)?$/;
const MAX_LISTED = 500;

function listFiles(dir: string, ext: string): { name: string; file: string; sizeBytes: number }[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(ext))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_LISTED)
    .map(e => ({ name: e.name.slice(0, -ext.length), file: path.join(dir, e.name), sizeBytes: fs.statSync(path.join(dir, e.name)).size }));
}

function pngSize(file: string): { width?: number; height?: number } {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(24);
      fs.readSync(fd, head, 0, 24, 0);
      if (head.subarray(1, 4).toString("latin1") !== "PNG") return {};
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
}

interface SampleInfo { name: string; file: string; sizeBytes: number; models?: number; nodes?: number; animated?: boolean; error?: string }
function describeSample(entry: { name: string; file: string; sizeBytes: number }, maxBytes: number): SampleInfo {
  const info: SampleInfo = { ...entry };
  try {
    if (entry.sizeBytes > maxBytes) throw new Error("File exceeds the size limit");
    const scene = decodeVOXScene(fs.readFileSync(entry.file));
    info.models = scene.models.length;
    info.nodes = scene.nodes.length;
    info.animated = scene.nodes.some(n => (n.type === "nTRN" && n.frames.length > 1) || (n.type === "nSHP" && n.models.length > 1));
  } catch (error) { info.error = error instanceof Error ? error.message : String(error); }
  return info;
}

/** Register discovery tools, resources and the read-only install roots. Nothing here writes to the installation. */
export function registerInstallTools(options: { server: McpServer; register: RegisterTool; registry: ModelRegistry; files: FilePolicy; config: MagicaConfig }): void {
  const { server, register, registry, files, config } = options;
  const resolved = tryResolveInstall({ ...process.env, MAGICAVOXEL_PATH: config.getMagicaPath() ?? process.env.MAGICAVOXEL_PATH });
  const install = resolved.install;
  const unavailable = () => {
    const reason = resolved.error ?? "MagicaVoxel installation not found";
    return new Error(reason.includes("MAGICAVOXEL_HOME") ? reason : `${reason}. Check MAGICAVOXEL_HOME (installation folder) or MAGICAVOXEL_PATH (MagicaVoxel.exe).`);
  };
  const need = (): MagicaInstall => { if (!install) throw unavailable(); return install; };
  if (install) {
    for (const root of installReadRoots(install)) files.addReadRoot(root.dir, { allowExt: root.allowExt });
    if (!config.getMagicaPath()) config.setMagicaPath(install.exe);
  }

  const samples = (): SampleInfo[] => {
    const i = need();
    const entries = [
      ...listFiles(i.dirs.vox, ".vox"),
      ...listFiles(path.join(i.dirs.vox, "anim"), ".vox").map(e => ({ ...e, name: `anim/${e.name}` }))
    ];
    return entries.map(e => describeSample(e, files.maxInputBytes));
  };
  const palettes = () => listFiles(need().dirs.palette, ".png").map(e => ({ ...e, ...pngSize(e.file) }));
  const shaders = () => listFiles(need().dirs.shader, ".txt");
  const ibl = () => listFiles(need().dirs.ibl, ".hdr");
  const info = () => {
    const i = need();
    const parsed = readConfigFile(i.configFile, i.root);
    return {
      version: i.version, os: i.os, root: i.root, exe: i.exe, dirs: i.dirs,
      config: parsed.config, configWarnings: parsed.warnings,
      counts: {
        samples: listFiles(i.dirs.vox, ".vox").length + listFiles(path.join(i.dirs.vox, "anim"), ".vox").length,
        palettes: listFiles(i.dirs.palette, ".png").length, shaders: listFiles(i.dirs.shader, ".txt").length, ibl: listFiles(i.dirs.ibl, ".hdr").length
      }
    };
  };

  const empty = z.object({}).strict();
  register({ name: "get_magicavoxel_info", description: "Report the MagicaVoxel installation: version, folders, parsed config.txt (workspace folders and export settings) and file counts. Read-only; needs MAGICAVOXEL_HOME or MAGICAVOXEL_PATH", inputSchema: empty }, async () => json(info()));
  register({ name: "list_magicavoxel_samples", description: "List the sample .vox files shipped with MagicaVoxel (including the anim folder) with size, model count and whether they are animated. Read-only", inputSchema: empty }, async () => json(samples().map(({ file: _file, ...rest }) => rest)));
  register({ name: "list_magicavoxel_palettes", description: "List the palette images shipped with MagicaVoxel with their pixel size. Read-only", inputSchema: empty }, async () => json(palettes().map(({ file: _file, ...rest }) => rest)));
  register({ name: "list_magicavoxel_shaders", description: "List the xs shader scripts shipped with MagicaVoxel. Read-only", inputSchema: empty }, async () => json(shaders().map(({ file: _file, ...rest }) => rest)));
  register({ name: "list_magicavoxel_ibl", description: "List the environment (HDR) images shipped with MagicaVoxel. Read-only", inputSchema: empty }, async () => json(ibl().map(({ file: _file, ...rest }) => rest)));
  register({
    name: "load_magicavoxel_sample",
    description: "Load a single-model MagicaVoxel sample by its listed name (for example cube or anim/name) into the model registry and return the model id",
    inputSchema: z.object({ name: z.string().min(1).max(128) }).strict()
  }, async ({ name }) => {
    const i = need();
    if (!SAMPLE_NAME.test(name)) throw new Error("Invalid sample name; use a name from list_magicavoxel_samples");
    const wanted = name.toLowerCase();
    const found = [...listFiles(i.dirs.vox, ".vox"), ...listFiles(path.join(i.dirs.vox, "anim"), ".vox").map(e => ({ ...e, name: `anim/${e.name}` }))].find(e => e.name.toLowerCase() === wanted);
    if (!found) throw new Error(`Sample not found: ${name}. Use a name from list_magicavoxel_samples`);
    const model = loadVOX(files.resolve(found.file, "read"));
    const { id } = registry.create(model.sizeX, model.sizeY, model.sizeZ);
    registry.set(id, model);
    return json({ id, name: found.name });
  });

  const resource = (name: string, uri: string, description: string, read: () => unknown) => {
    server.registerResource(name, uri, { mimeType: "application/json", description }, async resourceUri => ({
      contents: [{ uri: resourceUri.href, mimeType: "application/json", text: JSON.stringify(read()) }]
    }));
  };
  const strip = <T extends { file: string }>(rows: T[]) => rows.map(({ file: _file, ...rest }) => rest);
  resource("install", "magicavoxel://install", "MagicaVoxel installation summary", info);
  resource("install_samples", "magicavoxel://samples", "Sample .vox files in the MagicaVoxel installation", () => strip(samples()));
  resource("install_palettes", "magicavoxel://palettes", "Palette images in the MagicaVoxel installation", () => strip(palettes()));
  resource("install_shaders", "magicavoxel://shaders", "xs shader scripts in the MagicaVoxel installation", () => strip(shaders()));
  // Deprecated aliases: the plain file-name lists these URIs always returned, now read from the installation.
  resource("samples", "magicavoxel:samples", "Deprecated: use magicavoxel://samples. File names in the installation vox folder", () => listFiles(need().dirs.vox, ".vox").map(e => `${e.name}.vox`));
  resource("palettes", "magicavoxel:palettes", "Deprecated: use magicavoxel://palettes. File names in the installation palette folder", () => listFiles(need().dirs.palette, ".png").map(e => `${e.name}.png`));
}

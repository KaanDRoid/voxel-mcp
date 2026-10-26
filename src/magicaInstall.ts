import fs from "node:fs";
import path from "node:path";

/** Folders every complete installation is expected to have. Nothing in this module writes to them. */
export interface InstallDirs { config: string; vox: string; palette: string; shader: string; ibl: string }
export interface MagicaInstall {
  exe: string;
  root: string;
  version: string | undefined;
  os: string | undefined;
  dirs: InstallDirs;
  configFile: string;
}

const EXE_NAME = /^MagicaVoxel(?:\.exe)?$/i;
const REQUIRED_DIRS = ["vox", "palette", "shader", "ibl"] as const;

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Find the executable inside an installation folder. */
function findExe(root: string): string | undefined {
  for (const name of ["MagicaVoxel.exe", "MagicaVoxel"]) if (isFile(path.join(root, name))) return path.join(root, name);
  return undefined;
}

function readReadme(root: string): { version: string | undefined; os: string | undefined } {
  try {
    const text = fs.readFileSync(path.join(root, "readme.txt"), "utf8").slice(0, 16384);
    return { version: /^\s*version\s*:\s*(\S+)/im.exec(text)?.[1], os: /^\s*os\s*:\s*(\S+)/im.exec(text)?.[1] };
  } catch { return { version: undefined, os: undefined }; }
}

/**
 * Resolve the installation from MAGICAVOXEL_PATH (the executable) or MAGICAVOXEL_HOME (the folder).
 * MAGICAVOXEL_PATH wins when both are set. Read-only: nothing is created or modified.
 */
export function resolveInstall(env: Record<string, string | undefined> = process.env): MagicaInstall {
  const exeVar = env.MAGICAVOXEL_PATH, homeVar = env.MAGICAVOXEL_HOME;
  let exe: string, root: string;
  if (exeVar) {
    const absolute = path.resolve(exeVar);
    if (!EXE_NAME.test(path.basename(absolute))) throw new Error("MAGICAVOXEL_PATH must point to MagicaVoxel or MagicaVoxel.exe");
    if (!isFile(absolute)) throw new Error(`MagicaVoxel executable not found at ${absolute}`);
    exe = fs.realpathSync(absolute);
    root = path.dirname(exe);
  } else if (homeVar) {
    const absolute = path.resolve(homeVar);
    if (!isDirectory(absolute)) throw new Error(`MAGICAVOXEL_HOME is not a directory: ${absolute}`);
    root = fs.realpathSync(absolute);
    const found = findExe(root);
    if (!found) throw new Error(`No MagicaVoxel executable found in ${root}`);
    exe = found;
  } else {
    throw new Error("MagicaVoxel installation not configured; set MAGICAVOXEL_PATH (path to MagicaVoxel.exe) or MAGICAVOXEL_HOME (the installation folder).");
  }
  const missing = REQUIRED_DIRS.filter(d => !isDirectory(path.join(root, d)));
  const configFile = path.join(root, "config", "config.txt");
  if (!isFile(configFile)) (missing as string[]).push("config/config.txt");
  if (missing.length) throw new Error(`Incomplete MagicaVoxel installation at ${root}: missing ${missing.join(", ")}`);
  const { version, os: osName } = readReadme(root);
  const dirs: InstallDirs = { config: path.join(root, "config"), vox: path.join(root, "vox"), palette: path.join(root, "palette"), shader: path.join(root, "shader"), ibl: path.join(root, "ibl") };
  return { exe, root, version, os: osName, dirs, configFile };
}

/** Like resolveInstall, but reports the problem instead of throwing. */
export function tryResolveInstall(env: Record<string, string | undefined> = process.env): { install?: MagicaInstall; error?: string } {
  try { return { install: resolveInstall(env) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

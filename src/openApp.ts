import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface OpenOptions {
  /** Path of the application executable, or null when not configured. */
  exe: string | null;
  /** Absolute path of the file to open (already confined by the file policy). */
  file: string;
  /** Working directory for the application; defaults to the executable's folder. */
  cwd?: string;
  /** Injected in tests so the real application is never started. */
  spawnFn?: typeof spawn;
}

/** Start the application on a .vox file. Resolves once the process has spawned. */
export async function openVoxFile({ exe, file, cwd, spawnFn = spawn }: OpenOptions): Promise<string> {
  if (!exe) throw new Error("MagicaVoxel executable not configured; set the MAGICAVOXEL_PATH environment variable to the full path of MagicaVoxel.exe (or MAGICAVOXEL_HOME to the installation folder).");
  if (path.extname(file).toLowerCase() !== ".vox") throw new Error("Only .vox files can be opened");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`File not found: ${file}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(exe, [file], { cwd: cwd ?? path.dirname(exe), detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return file;
}

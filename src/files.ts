import fs from "node:fs";
import path from "node:path";

/** File access is confined to a user-selected workspace, including symlink targets. */
export class FilePolicy {
  readonly root: string;
  constructor(root = process.env.MAGICVOXEL_MCP_WORKSPACE ?? process.cwd(), readonly maxInputBytes = 64 * 1024 * 1024) {
    this.root = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(this.root).isDirectory()) throw new Error("Workspace must be a directory");
  }

  private readonly readRoots: { dir: string; allowExt: Set<string> }[] = [];

  private static isInside(base: string, candidate: string): boolean {
    const relative = path.relative(base, candidate);
    return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
  }

  private assertInside(candidate: string): void {
    if (!FilePolicy.isInside(this.root, candidate)) throw new Error("Path is outside the configured workspace");
  }

  /**
   * Allow reading (never writing) files with the given extensions from a folder outside the workspace.
   * Only absolute paths reach a read root; executables and libraries can never be allowed.
   */
  addReadRoot(dir: string, options: { allowExt: string[] }): void {
    const allowExt = new Set(options.allowExt.map(e => e.toLowerCase()));
    if ([...allowExt].some(e => /^\.(exe|dll|bat|cmd|com|msi|ps1|sh|so|dylib|app)$/.test(e) || !/^\.[a-z0-9]+$/.test(e))) throw new Error("Executable or invalid extensions cannot be allowed on a read root");
    const real = fs.realpathSync(path.resolve(dir));
    if (!fs.statSync(real).isDirectory()) throw new Error("Read root must be a directory");
    this.readRoots.push({ dir: real, allowExt });
  }

  private resolveReadRoot(candidate: string): string | undefined {
    const root = this.readRoots.find(r => FilePolicy.isInside(r.dir, candidate) && candidate !== r.dir);
    if (!root) return undefined;
    if (!root.allowExt.has(path.extname(candidate).toLowerCase())) throw new Error("This file type is not readable from a read-only root");
    const real = fs.realpathSync(candidate);
    if (!FilePolicy.isInside(root.dir, real) || !root.allowExt.has(path.extname(real).toLowerCase())) throw new Error("Path is outside the configured workspace");
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error("Input path must be a regular file");
    if (stat.size > this.maxInputBytes) throw new Error("Input file exceeds the size limit");
    return candidate;
  }

  resolve(value: string, mode: "read" | "write" | "directory" | "outputDirectory"): string {
    if (!value || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error("Invalid file path");
    if (process.platform === "win32" && /:/.test(value.replace(/^[A-Za-z]:[\\/]/, ""))) throw new Error("Invalid file path");
    if (process.platform === "win32" && value.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part))) throw new Error("Reserved device name");
    const candidate = path.resolve(this.root, value);
    if (mode === "read" && path.isAbsolute(value) && !FilePolicy.isInside(this.root, candidate)) {
      const viaRoot = this.resolveReadRoot(candidate);
      if (viaRoot) return viaRoot;
    }
    this.assertInside(candidate);
    let existing = candidate;
    while (!fs.existsSync(existing)) {
      try { if (fs.lstatSync(existing).isSymbolicLink()) throw new Error("Unresolved workspace symlink"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("No existing workspace ancestor");
      existing = parent;
    }
    this.assertInside(fs.realpathSync(existing));
    if (mode === "read") {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) throw new Error("Input path must be a regular file");
      if (stat.size > this.maxInputBytes) throw new Error("Input file exceeds the size limit");
    } else if (mode === "directory") {
      if (!fs.statSync(candidate).isDirectory()) throw new Error("Path must be a directory");
    } else if (mode === "write" && fs.existsSync(candidate) && !fs.statSync(candidate).isFile()) {
      throw new Error("Output path must be a regular file");
    }
    return candidate;
  }

  prepareOutput(value: string, directory = false): string {
    const target = this.resolve(value, directory ? "outputDirectory" : "write");
    fs.mkdirSync(directory ? target : path.dirname(target), { recursive: true });
    this.assertInside(fs.realpathSync(directory ? target : path.dirname(target)));
    return target;
  }
}


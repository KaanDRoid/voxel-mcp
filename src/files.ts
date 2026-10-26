import fs from "node:fs";
import path from "node:path";

/** File access is confined to a user-selected workspace, including symlink targets. */
export class FilePolicy {
  readonly root: string;
  constructor(root = process.env.VOXEL_MCP_WORKSPACE ?? process.cwd(), readonly maxInputBytes = 64 * 1024 * 1024) {
    this.root = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(this.root).isDirectory()) throw new Error("Workspace must be a directory");
  }

  private assertInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Path is outside the configured workspace");
    }
  }

  resolve(value: string, mode: "read" | "write" | "directory" | "outputDirectory"): string {
    if (!value || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error("Invalid file path");
    if (process.platform === "win32" && /:/.test(value.replace(/^[A-Za-z]:[\\/]/, ""))) throw new Error("Invalid file path");
    if (process.platform === "win32" && value.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part))) throw new Error("Reserved device name");
    const candidate = path.resolve(this.root, value);
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


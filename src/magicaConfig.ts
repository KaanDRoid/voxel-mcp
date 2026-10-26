import path from "path";
import fs from "fs";

export class MagicaConfig {
  private magicaPath: string | null = null;

  constructor(initialPath?: string) {
    if (initialPath) this.setMagicaPath(initialPath);
  }

  setMagicaPath(p: string) {
    const absolute = path.resolve(p);
    if (!/^MagicaVoxel(?:\.exe)?$/i.test(path.basename(absolute))) throw new Error("Executable must be named MagicaVoxel or MagicaVoxel.exe");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`MagicaVoxel executable file not found at ${absolute}`);
    this.magicaPath = fs.realpathSync(absolute);
  }

  getMagicaPath() {
    return this.magicaPath;
  }
}

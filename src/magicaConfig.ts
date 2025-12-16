import path from "path";
import fs from "fs";

export class MagicaConfig {
  private magicaPath: string | null = null;

  constructor(initialPath?: string) {
    if (initialPath) this.setMagicaPath(initialPath);
    else this.autodetect();
  }

  autodetect() {
    const cwd = process.cwd();
    const parent = path.resolve(cwd, "..");
    const candidates = [
      path.join(cwd, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel.exe"),
      path.join(cwd, "MagicaVoxel.exe"),
      path.join(parent, "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel-0.99.7.2-win64", "MagicaVoxel.exe"),
      path.join(parent, "MagicaVoxel.exe"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.magicaPath = p;
        break;
      }
    }
  }

  setMagicaPath(p: string) {
    if (!fs.existsSync(p)) throw new Error(`MagicaVoxel not found at ${p}`);
    this.magicaPath = p;
  }

  getMagicaPath() {
    return this.magicaPath;
  }
}

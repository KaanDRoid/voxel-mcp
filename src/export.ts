import fs from "fs";
import nodePath from "path";
import { PNG } from "pngjs";
import { defaultPalette, type VoxModelData } from "./vox.js";
import { buildQuads, occupancy } from "./formats/mesh.js";
import { fmt, makeTransform } from "./formats/axes.js";
import { paletteToPng } from "./paletteFormats.js";
import { unpackRGBA } from "./color.js";

/** Write a file inside an output folder without following an existing symlink entry. */
export function writeFileNoFollow(file: string, data: Uint8Array | string) {
  let existing: fs.Stats | undefined;
  try { existing = fs.lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${file}`);
  if (existing && !existing.isFile()) throw new Error(`refusing to overwrite non-file entry: ${file}`);
  if (existing) fs.unlinkSync(file);
  fs.writeFileSync(file, data, { flag: "wx" });
}

export interface ObjOptions {
  /** "basic": single file with vertex colors, unit scale. "magica": MagicaVoxel-style obj + mtl + palette PNG,
   * scale 0.1, merged faces (the defaults of the io_obj block in MagicaVoxel's config.txt). */
  profile?: "basic" | "magica" | undefined;
  /** Output units per voxel edge. */
  scale?: number | undefined;
  /** Output axes, e.g. "XYZ" (Z up) or "XZ-Y" (Y up, the default). */
  axis?: string | undefined;
  /** Clockwise face winding instead of counter-clockwise. */
  cw?: boolean | undefined;
  /** Merge coplanar faces of the same color. */
  merge?: boolean | undefined;
}
export interface MeshStats { vertices: number; faces: number; files: string[] }

export function exportOBJ(model: VoxModelData, path: string, opts: ObjOptions = {}): MeshStats {
  const magica = opts.profile === "magica";
  const t = makeTransform({ axis: opts.axis, scale: opts.scale ?? (magica ? 0.1 : 1), cw: opts.cw }, "XZ-Y");
  const merge = opts.merge ?? magica;
  const quads = buildQuads(model, merge);
  const palette = model.palette ?? defaultPalette();
  const base = nodePath.basename(path).replace(/\.[^.]*$/, "") || "model";
  const vertexLines: string[] = [], vertexMap = new Map<string, number>();
  const vertexIndex = (p: number[], color: number) => {
    const key = magica ? p.join(",") : `${p.join(",")},${color}`;
    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = vertexLines.length; vertexMap.set(key, idx);
      const out = t.point(p).map(fmt);
      if (magica) vertexLines.push(`v ${out.join(" ")}`);
      else { const c = unpackRGBA(palette[color] ?? 0); vertexLines.push(`v ${out.join(" ")} ${fmt(c.r / 255)} ${fmt(c.g / 255)} ${fmt(c.b / 255)}`); }
    }
    return idx + 1;
  };
  const uvIndex = new Map<number, number>(), uvLines: string[] = [];
  const faceLines: string[] = [];
  for (const q of quads) {
    let ids = q.corners.map(c => vertexIndex(c, q.color));
    let uv = 0;
    if (magica) {
      let u = uvIndex.get(q.color);
      if (u === undefined) { u = uvLines.length + 1; uvIndex.set(q.color, u); uvLines.push(`vt ${fmt(((q.color - 1) + 0.5) / 256)} 0.5`); }
      uv = u;
    }
    if (t.flip) ids = ids.reverse();
    faceLines.push("f " + ids.map(i => (magica ? `${i}/${uv}` : String(i))).join(" "));
  }
  const header = magica
    ? `# Voxel mesh, scale ${fmt(t.scale)}, axis ${t.axis.name}\nmtllib ${base}.mtl\nusemtl palette\n`
    : "# Voxel surface; vertex RGB extension (no external material files)\n";
  const body = `${header}# Vertices: ${vertexLines.length}, Faces: ${faceLines.length}\n\n${vertexLines.join("\n")}\n${uvLines.join("\n")}${uvLines.length ? "\n" : ""}\n${faceLines.join("\n")}\n`;
  const files = [path];
  if (magica) {
    const dir = nodePath.dirname(path);
    const mtl = nodePath.join(dir, `${base}.mtl`), tex = nodePath.join(dir, `${base}.png`);
    writeFileNoFollow(mtl, `newmtl palette\nKa 1 1 1\nKd 1 1 1\nd 1\nmap_Kd ${base}.png\n`);
    writeFileNoFollow(tex, paletteToPng(palette));
    files.push(mtl, tex);
  }
  fs.writeFileSync(path, body);
  return { vertices: vertexLines.length, faces: faceLines.length, files };
}

/** Point cloud: one vertex per voxel, at the voxel corner (voxel coordinates), with vertex colors. */
export function exportPLY(model: VoxModelData, path: string, opts: { scale?: number | undefined; axis?: string | undefined } = {}) {
  const t = makeTransform({ axis: opts.axis, scale: opts.scale }, "XZ-Y");
  const palette = model.palette ?? defaultPalette();
  const lines: string[] = [];
  for (const v of model.voxels) {
    if (v.i <= 0 || v.x < 0 || v.x >= model.sizeX || v.y < 0 || v.y >= model.sizeY || v.z < 0 || v.z >= model.sizeZ) continue;
    const c = unpackRGBA(palette[v.i] ?? 0);
    lines.push(`${t.point([v.x, v.y, v.z]).map(fmt).join(" ")} ${c.r} ${c.g} ${c.b}`);
  }
  const header = ["ply", "format ascii 1.0", `element vertex ${lines.length}`, "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue", "end_header"];
  fs.writeFileSync(path, header.join("\n") + "\n" + lines.join("\n") + (lines.length ? "\n" : ""));
}

export function exportSlices(model: VoxModelData, folder: string) {
  const palette = model.palette ?? defaultPalette();
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = occupancy(model);
  fs.mkdirSync(folder, { recursive: true });
  for (let z = 0; z < sz; z++) {
    const png = new PNG({ width: sx, height: sy });
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const color = occ[x + sx * (y + sy * z)]!;
        if (color === 0) continue;
        const c = unpackRGBA(palette[color] ?? 0);
        png.data.set([c.r, c.g, c.b, c.a], (y * sx + x) * 4);
      }
    }
    writeFileNoFollow(`${folder}/slice_${String(z).padStart(4, "0")}.png`, PNG.sync.write(png));
  }
}

import type { VoxModelData } from "./vox.js";

export function autoUvColor(model: VoxModelData) {
  const maxZ = Math.max(1, model.sizeZ - 1);
  for (const v of model.voxels) {
    const t = v.z / maxZ;
    v.i = Math.max(1, Math.min(255, Math.round(50 + t * 200)));
  }
}

export function detectSymmetry(model: VoxModelData): { axis: "x" | "y" | "z"; score: number } {
  const scoreAxis = (axis: "x" | "y" | "z") => {
    const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
    const set = new Set(model.voxels.map(v => `${v.x},${v.y},${v.z}`));
    let match = 0, total = 0;
    for (const v of model.voxels) {
      let mx = v.x, my = v.y, mz = v.z;
      if (axis === "x") mx = (sx - 1) - v.x; else if (axis === "y") my = (sy - 1) - v.y; else mz = (sz - 1) - v.z;
      total++;
      if (set.has(`${mx},${my},${mz}`)) match++;
    }
    return total ? match / total : 1;
  };
  const sx = scoreAxis("x"), sy = scoreAxis("y"), sz = scoreAxis("z");
  const axis = sx >= sy && sx >= sz ? "x" : sy >= sz ? "y" : "z";
  const score = Math.max(sx, sy, sz);
  return { axis, score };
}

export function makeSymmetric(model: VoxModelData, axis: "x" | "y" | "z") {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const out = new Map<string, number>();
  for (const v of model.voxels) {
    const k1 = `${v.x},${v.y},${v.z}`; out.set(k1, v.i);
    let mx=v.x,my=v.y,mz=v.z; if (axis==="x") mx=(sx-1)-v.x; else if (axis==="y") my=(sy-1)-v.y; else mz=(sz-1)-v.z;
    const k2 = `${mx},${my},${mz}`; out.set(k2, out.get(k2) ?? v.i);
  }
  model.voxels = Array.from(out.entries()).map(([k,i]) => { const parts = k.split(",").map(Number); return { x: Number(parts[0] ?? 0), y: Number(parts[1] ?? 0), z: Number(parts[2] ?? 0), i: i! }; });
}

export function simplifyModel(model: VoxModelData, factor: number) {
  const f = Math.max(1, Math.floor(factor)); if (f === 1) return;
  const nx = Math.max(1, Math.floor(model.sizeX / f)), ny = Math.max(1, Math.floor(model.sizeY / f)), nz = Math.max(1, Math.floor(model.sizeZ / f));
  const occ = new Map<string, number>();
  for (const v of model.voxels) {
    const x = Math.floor(v.x / f), y = Math.floor(v.y / f), z = Math.floor(v.z / f);
    const k = `${x},${y},${z}`; if (!occ.has(k)) occ.set(k, v.i);
  }
  model.sizeX = nx; model.sizeY = ny; model.sizeZ = nz;
  model.voxels = Array.from(occ.entries()).map(([k,i]) => { const parts = k.split(",").map(Number); return { x: Number(parts[0] ?? 0), y: Number(parts[1] ?? 0), z: Number(parts[2] ?? 0), i: i! }; });
}

const FONT_5x7: Record<string, string[]> = {
  A: [" 1 ","1 1","111","1 1","1 1"],
  B: ["11 ","1 1","11 ","1 1","11 "],
  C: [" 11","1  ","1  ","1  "," 11"],
  D: ["11 ","1 1","1 1","1 1","11 "],
  E: ["111","1  ","11 ","1  ","111"],
  F: ["111","1  ","11 ","1  ","1  "],
  G: [" 11","1  ","1 1","1 1"," 11"],
  H: ["1 1","1 1","111","1 1","1 1"],
  I: ["111"," 1 "," 1 "," 1 ","111"],
  J: [" 11","  1","  1","1 1"," 1 "],
  K: ["1 1","1 1","11 ","1 1","1 1"],
  L: ["1  ","1  ","1  ","1  ","111"],
  M: ["1 1","111","111","1 1","1 1"],
  N: ["1 1","111","111","1 1","1 1"],
  O: ["111","1 1","1 1","1 1","111"],
  P: ["11 ","1 1","11 ","1  ","1  "],
  Q: ["111","1 1","1 1","111","  1"],
  R: ["11 ","1 1","11 ","1 1","1 1"],
  S: [" 11","1  ","11 ","  1","11 "],
  T: ["111"," 1 "," 1 "," 1 "," 1 "],
  U: ["1 1","1 1","1 1","1 1","111"],
  V: ["1 1","1 1","1 1","1 1"," 1 "],
  W: ["1 1","1 1","111","111","1 1"],
  X: ["1 1","1 1"," 1 ","1 1","1 1"],
  Y: ["1 1","1 1"," 1 "," 1 "," 1 "],
  Z: ["111","  1"," 1 ","1  ","111"],
  " ": ["   ","   ","   ","   ","   "]
};

export function voxelizeText(model: VoxModelData, text: string, i: number, thickness = 1) {
  const chars = text.toUpperCase().split("");
  let xOff = 0;
  for (const ch of chars) {
    const glyph = FONT_5x7[ch] ?? FONT_5x7[" "]!;
    for (let gy = 0; gy < glyph.length; gy++) {
      const row = glyph[gy] ?? "";
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] === "1") {
          for (let z = 0; z < Math.min(model.sizeZ, thickness); z++) {
            const x = xOff + gx, y = gy; if (x < model.sizeX && y < model.sizeY) model.voxels.push({ x, y, z, i });
          }
        }
      }
    }
    xOff += ((glyph[0] ?? "").length || 3) + 1;
  }
}

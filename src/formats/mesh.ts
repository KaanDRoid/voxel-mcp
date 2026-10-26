import type { VoxModelData } from "../vox.js";

export interface Quad {
  /** Four corners in voxel space, counter-clockwise when seen from outside. */
  corners: [number, number, number][];
  normal: [number, number, number];
  color: number;
}

type Vec = [number, number, number];
const DIRS: { axis: 0 | 1 | 2; sign: 1 | -1; corners: Vec[] }[] = [
  { axis: 0, sign: 1, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { axis: 0, sign: -1, corners: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
  { axis: 1, sign: 1, corners: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]] },
  { axis: 1, sign: -1, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { axis: 2, sign: 1, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { axis: 2, sign: -1, corners: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
];

/** Occupancy grid of palette indices (0 = empty); invalid or out-of-range voxels are ignored. */
export function occupancy(model: VoxModelData): Uint8Array {
  const { sizeX: sx, sizeY: sy, sizeZ: sz } = model;
  const grid = new Uint8Array(sx * sy * sz);
  for (const v of model.voxels) {
    if (v.i > 0 && Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z) && v.x >= 0 && v.x < sx && v.y >= 0 && v.y < sy && v.z >= 0 && v.z < sz) {
      grid[v.x + sx * (v.y + sy * v.z)] = v.i;
    }
  }
  return grid;
}

/** Exposed voxel faces. With `merge` set, coplanar neighbors of the same color are combined greedily. */
export function buildQuads(model: VoxModelData, merge = false): Quad[] {
  const size = [model.sizeX, model.sizeY, model.sizeZ];
  const grid = occupancy(model);
  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= size[0]! || y >= size[1]! || z >= size[2]! ? 0 : grid[x + size[0]! * (y + size[1]! * z)]!;
  const quads: Quad[] = [];
  for (const dir of DIRS) {
    const a = dir.axis, u = (a + 1) % 3, v = (a + 2) % 3;
    const normal: Vec = [0, 0, 0];
    normal[a] = dir.sign;
    const du = size[u]!, dv = size[v]!;
    for (let s = 0; s < size[a]!; s++) {
      const mask = new Uint8Array(du * dv);
      for (let j = 0; j < dv; j++) for (let i = 0; i < du; i++) {
        const p: Vec = [0, 0, 0];
        p[a] = s; p[u] = i; p[v] = j;
        const color = at(p[0], p[1], p[2]);
        if (color && !at(p[0] + normal[0], p[1] + normal[1], p[2] + normal[2])) mask[i + du * j] = color;
      }
      for (let j = 0; j < dv; j++) for (let i = 0; i < du; i++) {
        const color = mask[i + du * j]!;
        if (!color) continue;
        let w = 1, h = 1;
        if (merge) {
          while (i + w < du && mask[i + w + du * j] === color) w++;
          outer: while (j + h < dv) {
            for (let k = 0; k < w; k++) if (mask[i + k + du * (j + h)] !== color) break outer;
            h++;
          }
        }
        for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + du * (j + jj)] = 0;
        const base: Vec = [0, 0, 0];
        base[a] = s; base[u] = i; base[v] = j;
        const corners = dir.corners.map(c => {
          const out = [base[0] + c[0], base[1] + c[1], base[2] + c[2]];
          if (c[u]) out[u] = out[u]! + w - 1;
          if (c[v]) out[v] = out[v]! + h - 1;
          return out as Vec;
        });
        quads.push({ corners, normal, color });
      }
    }
  }
  return quads;
}

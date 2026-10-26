/** Triangle mesh voxelization: surface by triangle/box overlap, volume by ray parity through voxel centers.
 * Coordinates are in voxel units: voxel (i, j, k) occupies [i, i+1] x [j, j+1] x [k, k+1]. */
export interface MeshInput {
  /** Nine numbers per triangle (three xyz vertices) in voxel space. */
  positions: Float64Array;
  count: number;
}
export interface VoxelizeOptions {
  /** "volume" marks voxels whose center lies inside a watertight mesh (ray parity along Z); "surface" marks
   * every voxel touched by a triangle (conservative triangle/box overlap). */
  mode: "volume" | "surface";
  /** Color (24-bit rgb) at barycentric weights of a triangle, or -1 when the triangle has no color. */
  colorAt?: ((tri: number, w0: number, w1: number, w2: number) => number) | undefined;
  /** Abort with an error after this many milliseconds. */
  budgetMs: number;
}
export interface VoxelizeResult {
  dims: [number, number, number];
  filled: Uint8Array;
  /** 24-bit color per cell, -1 when unknown; only present when `colorAt` was given. */
  color: Int32Array | undefined;
  inconsistentColumns: number;
}

const EPS = 1e-4;

function triBoxOverlap(c: number[], h: number, p: Float64Array, o: number): boolean {
  const v0x = p[o]! - c[0]!, v0y = p[o + 1]! - c[1]!, v0z = p[o + 2]! - c[2]!;
  const v1x = p[o + 3]! - c[0]!, v1y = p[o + 4]! - c[1]!, v1z = p[o + 5]! - c[2]!;
  const v2x = p[o + 6]! - c[0]!, v2y = p[o + 7]! - c[1]!, v2z = p[o + 8]! - c[2]!;
  if (Math.min(v0x, v1x, v2x) > h || Math.max(v0x, v1x, v2x) < -h) return false;
  if (Math.min(v0y, v1y, v2y) > h || Math.max(v0y, v1y, v2y) < -h) return false;
  if (Math.min(v0z, v1z, v2z) > h || Math.max(v0z, v1z, v2z) < -h) return false;
  const e = [[v1x - v0x, v1y - v0y, v1z - v0z], [v2x - v1x, v2y - v1y, v2z - v1z], [v0x - v2x, v0y - v2y, v0z - v2z]];
  const nx = e[0]![1]! * e[1]![2]! - e[0]![2]! * e[1]![1]!, ny = e[0]![2]! * e[1]![0]! - e[0]![0]! * e[1]![2]!, nz = e[0]![0]! * e[1]![1]! - e[0]![1]! * e[1]![0]!;
  if (Math.abs(nx * v0x + ny * v0y + nz * v0z) > h * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz))) return false;
  for (const [ex, ey, ez] of e as [number, number, number][]) {
    const axes: [number, number, number][] = [[0, -ez, ey], [ez, 0, -ex], [-ey, ex, 0]];
    for (const [ax, ay, az] of axes) {
      const q0 = ax * v0x + ay * v0y + az * v0z, q1 = ax * v1x + ay * v1y + az * v1z, q2 = ax * v2x + ay * v2y + az * v2z;
      const r = h * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
      if (Math.min(q0, q1, q2) > r || Math.max(q0, q1, q2) < -r) return false;
    }
  }
  return true;
}

/** Barycentric weights of the point of triangle abc closest to p (Ericson, Real-Time Collision Detection). */
function closestBary(p: number[], a: number[], b: number[], c: number[]): [number, number, number] {
  const sub = (u: number[], v: number[]) => [u[0]! - v[0]!, u[1]! - v[1]!, u[2]! - v[2]!];
  const dot = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return [1 - v - w, v, w];
}

export function voxelizeMesh(mesh: MeshInput, dims: [number, number, number], opts: VoxelizeOptions): VoxelizeResult {
  const [dx, dy, dz] = dims;
  const volume = dx * dy * dz;
  const filled = new Uint8Array(volume);
  const color = opts.colorAt ? new Int32Array(volume).fill(-1) : undefined;
  const started = Date.now();
  const h = 0.5 + EPS;
  const p = mesh.positions;
  const checkTime = () => { if (Date.now() - started > opts.budgetMs) throw new Error("OBJ import exceeded the time budget; reduce the triangle count or the target size"); };
  for (let t = 0; t < (opts.mode === "surface" ? mesh.count : 0); t++) {
    if ((t & 255) === 0) checkTime();
    const o = t * 9;
    const lo = [0, 1, 2].map(a => Math.min(p[o + a]!, p[o + 3 + a]!, p[o + 6 + a]!)), hi = [0, 1, 2].map(a => Math.max(p[o + a]!, p[o + 3 + a]!, p[o + 6 + a]!));
    const i0 = Math.max(0, Math.floor(lo[0]! - 1e-3)), i1 = Math.min(dx - 1, Math.floor(hi[0]! + 1e-3));
    const j0 = Math.max(0, Math.floor(lo[1]! - 1e-3)), j1 = Math.min(dy - 1, Math.floor(hi[1]! + 1e-3));
    const k0 = Math.max(0, Math.floor(lo[2]! - 1e-3)), k1 = Math.min(dz - 1, Math.floor(hi[2]! + 1e-3));
    let tested = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if ((++tested & 0xfffff) === 0) checkTime();
      const center = [i + 0.5, j + 0.5, k + 0.5];
      if (!triBoxOverlap(center, h, p, o)) continue;
      const cell = i + dx * (j + dy * k);
      filled[cell] = 1;
      if (color && color[cell] === -1) {
        const w = closestBary(center, [p[o]!, p[o + 1]!, p[o + 2]!], [p[o + 3]!, p[o + 4]!, p[o + 5]!], [p[o + 6]!, p[o + 7]!, p[o + 8]!]);
        color[cell] = opts.colorAt!(t, w[0], w[1], w[2]);
      }
    }
  }
  let inconsistentColumns = 0;
  if (opts.mode === "volume") {
    type Crossing = { z: number; tri: number; w: [number, number, number] };
    const columns = new Map<number, Crossing[]>();
    for (let t = 0; t < mesh.count; t++) {
      if ((t & 255) === 0) checkTime();
      const o = t * 9;
      const ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!, bx = p[o + 3]!, by = p[o + 4]!, bz = p[o + 5]!, cx = p[o + 6]!, cy = p[o + 7]!, cz = p[o + 8]!;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), i1 = Math.min(dx - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), j1 = Math.min(dy - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = i + 0.5 + 1.37e-6, py = j + 0.5 + 2.71e-6;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const key = i + dx * j;
        let list = columns.get(key);
        if (!list) { list = []; columns.set(key, list); }
        list.push({ z: w0 * az + w1 * bz + w2 * cz, tri: t, w: [w0, w1, w2] });
      }
    }
    for (const [key, list] of columns) {
      const i = key % dx, j = Math.floor(key / dx);
      list.sort((a, b) => a.z - b.z);
      if (list.length % 2) { inconsistentColumns++; list.pop(); }
      for (let n = 0; n + 1 < list.length; n += 2) {
        const a = list[n]!, b = list[n + 1]!;
        const k0 = Math.max(0, Math.ceil(a.z - 0.5)), k1 = Math.min(dz - 1, Math.ceil(b.z - 0.5) - 1);
        for (let k = k0; k <= k1; k++) {
          const cell = i + dx * (j + dy * k);
          filled[cell] = 1;
          if (color && color[cell] === -1) {
            const near = Math.abs(k + 0.5 - a.z) <= Math.abs(b.z - (k + 0.5)) ? a : b;
            color[cell] = opts.colorAt!(near.tri, near.w[0], near.w[1], near.w[2]);
          }
        }
      }
    }
  }
  return { dims, filled, color, inconsistentColumns };
}

import type { VoxModelData } from "./vox.js";

export function measureDistance(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function getSurfaceArea(model: VoxModelData): number {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = 1;
  let area = 0;
  for (const v of model.voxels) {
    if (v.x === 0 || occ[idx(v.x - 1, v.y, v.z)] === 0) area++;
    if (v.x === sx - 1 || occ[idx(v.x + 1, v.y, v.z)] === 0) area++;
    if (v.y === 0 || occ[idx(v.x, v.y - 1, v.z)] === 0) area++;
    if (v.y === sy - 1 || occ[idx(v.x, v.y + 1, v.z)] === 0) area++;
    if (v.z === 0 || occ[idx(v.x, v.y, v.z - 1)] === 0) area++;
    if (v.z === sz - 1 || occ[idx(v.x, v.y, v.z + 1)] === 0) area++;
  }
  return area;
}

export function getVolume(model: VoxModelData): number {
  return model.voxels.length;
}

export function findCenter(model: VoxModelData): [number, number, number] {
  if (model.voxels.length === 0) return [0, 0, 0];
  let sx = 0, sy = 0, sz = 0;
  for (const v of model.voxels) { sx += v.x; sy += v.y; sz += v.z; }
  const n = model.voxels.length;
  return [sx / n, sy / n, sz / n];
}

export function getDimensions(model: VoxModelData): { min: [number, number, number]; max: [number, number, number] } {
  if (model.voxels.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of model.voxels) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function countColors(model: VoxModelData): Record<number, number> {
  const hist: Record<number, number> = {};
  for (const v of model.voxels) hist[v.i] = (hist[v.i] ?? 0) + 1;
  return hist;
}


import type { VoxModelData, Voxel } from "./vox.js";

export type ModelId = string;

export class ModelRegistry {
  private nextId = 1;
  private models = new Map<ModelId, VoxModelData>();

  create(sizeX: number, sizeY: number, sizeZ: number): { id: ModelId; model: VoxModelData } {
    const id = String(this.nextId++);
    const model: VoxModelData = { sizeX, sizeY, sizeZ, voxels: [] };
    this.models.set(id, model);
    return { id, model };
  }

  set(id: ModelId, model: VoxModelData) {
    this.models.set(id, model);
  }

  get(id: ModelId): VoxModelData {
    const m = this.models.get(id);
    if (!m) throw new Error(`Model ${id} not found`);
    return m;
  }

  list(): { id: string; size: [number, number, number]; voxels: number }[] {
    return Array.from(this.models.entries()).map(([id, m]) => ({ id, size: [m.sizeX, m.sizeY, m.sizeZ], voxels: m.voxels.length }));
  }

  delete(id: ModelId) {
    this.models.delete(id);
  }
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function fillBox(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, i: number) {
  const minX = clamp(Math.min(x0, x1), 0, model.sizeX - 1);
  const maxX = clamp(Math.max(x0, x1), 0, model.sizeX - 1);
  const minY = clamp(Math.min(y0, y1), 0, model.sizeY - 1);
  const maxY = clamp(Math.max(y0, y1), 0, model.sizeY - 1);
  const minZ = clamp(Math.min(z0, z1), 0, model.sizeZ - 1);
  const maxZ = clamp(Math.max(z0, z1), 0, model.sizeZ - 1);
  for (let z = minZ; z <= maxZ; z++)
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) model.voxels.push({ x, y, z, i });
}

export function fillSphere(model: VoxModelData, cx: number, cy: number, cz: number, r: number, i: number) {
  const r2 = r * r;
  for (let z = Math.max(0, cz - r); z <= Math.min(model.sizeZ - 1, cz + r); z++) {
    for (let y = Math.max(0, cy - r); y <= Math.min(model.sizeY - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(model.sizeX - 1, cx + r); x++) {
        const dx = x - cx,
          dy = y - cy,
          dz = z - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) model.voxels.push({ x, y, z, i });
      }
    }
  }
}

export function fillCylinder(model: VoxModelData, cx: number, cy: number, z0: number, z1: number, r: number, i: number) {
  const r2 = r * r;
  const minZ = clamp(Math.min(z0, z1), 0, model.sizeZ - 1);
  const maxZ = clamp(Math.max(z0, z1), 0, model.sizeZ - 1);
  for (let z = minZ; z <= maxZ; z++) {
    for (let y = Math.max(0, cy - r); y <= Math.min(model.sizeY - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(model.sizeX - 1, cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) model.voxels.push({ x, y, z, i });
      }
    }
  }
}

export function fillPyramid(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, height: number, i: number) {
  const minX = clamp(Math.min(x0, x1), 0, model.sizeX - 1);
  const maxX = clamp(Math.max(x0, x1), 0, model.sizeX - 1);
  const minY = clamp(Math.min(y0, y1), 0, model.sizeY - 1);
  const maxY = clamp(Math.max(y0, y1), 0, model.sizeY - 1);
  const baseW = maxX - minX;
  const baseH = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  for (let h = 0; h < height && z0 + h < model.sizeZ; h++) {
    const t = h / height;
    const hw = (baseW / 2) * (1 - t);
    const hh = (baseH / 2) * (1 - t);
    const lx = clamp(Math.floor(cx - hw), 0, model.sizeX - 1);
    const hx = clamp(Math.ceil(cx + hw), 0, model.sizeX - 1);
    const ly = clamp(Math.floor(cy - hh), 0, model.sizeY - 1);
    const hy = clamp(Math.ceil(cy + hh), 0, model.sizeY - 1);
    for (let y = ly; y <= hy; y++) {
      for (let x = lx; x <= hx; x++) {
        model.voxels.push({ x, y, z: z0 + h, i });
      }
    }
  }
}

export function fillCone(model: VoxModelData, cx: number, cy: number, z0: number, r: number, height: number, i: number) {
  for (let h = 0; h < height && z0 + h < model.sizeZ; h++) {
    const t = h / height;
    const cr = r * (1 - t);
    const cr2 = cr * cr;
    for (let y = Math.max(0, Math.floor(cy - cr)); y <= Math.min(model.sizeY - 1, Math.ceil(cy + cr)); y++) {
      for (let x = Math.max(0, Math.floor(cx - cr)); x <= Math.min(model.sizeX - 1, Math.ceil(cx + cr)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= cr2) model.voxels.push({ x, y, z: z0 + h, i });
      }
    }
  }
}

export function fillTorus(model: VoxModelData, cx: number, cy: number, cz: number, majorR: number, minorR: number, i: number) {
  for (let z = Math.max(0, cz - minorR); z <= Math.min(model.sizeZ - 1, cz + minorR); z++) {
    for (let y = Math.max(0, cy - majorR - minorR); y <= Math.min(model.sizeY - 1, cy + majorR + minorR); y++) {
      for (let x = Math.max(0, cx - majorR - minorR); x <= Math.min(model.sizeX - 1, cx + majorR + minorR); x++) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const distXY = Math.sqrt(dx * dx + dy * dy);
        const distFromRing = distXY - majorR;
        if (distFromRing * distFromRing + dz * dz <= minorR * minorR) {
          model.voxels.push({ x, y, z, i });
        }
      }
    }
  }
}

export function drawLine(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, i: number) {
  // 3D Bresenham's line algorithm
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  const dm = Math.max(dx, dy, dz);
  let x = x0, y = y0, z = z0;

  for (let step = 0; step <= dm; step++) {
    if (x >= 0 && x < model.sizeX && y >= 0 && y < model.sizeY && z >= 0 && z < model.sizeZ) {
      model.voxels.push({ x, y, z, i });
    }
    if (dm === dx) {
      x += sx;
      y = y0 + Math.round((step + 1) * dy / dm) * sy;
      z = z0 + Math.round((step + 1) * dz / dm) * sz;
    } else if (dm === dy) {
      y += sy;
      x = x0 + Math.round((step + 1) * dx / dm) * sx;
      z = z0 + Math.round((step + 1) * dz / dm) * sz;
    } else {
      z += sz;
      x = x0 + Math.round((step + 1) * dx / dm) * sx;
      y = y0 + Math.round((step + 1) * dy / dm) * sy;
    }
  }
}

export function scaleModel(model: VoxModelData, scaleX: number, scaleY: number, scaleZ: number): VoxModelData {
  const newSizeX = Math.max(1, Math.round(model.sizeX * scaleX));
  const newSizeY = Math.max(1, Math.round(model.sizeY * scaleY));
  const newSizeZ = Math.max(1, Math.round(model.sizeZ * scaleZ));
  const out: VoxModelData = { sizeX: newSizeX, sizeY: newSizeY, sizeZ: newSizeZ, voxels: [] };
  if (model.palette) out.palette = model.palette;
  
  for (const v of model.voxels) {
    const nx = Math.round(v.x * scaleX);
    const ny = Math.round(v.y * scaleY);
    const nz = Math.round(v.z * scaleZ);
    if (nx >= 0 && nx < newSizeX && ny >= 0 && ny < newSizeY && nz >= 0 && nz < newSizeZ) {
      out.voxels.push({ x: nx, y: ny, z: nz, i: v.i });
    }
  }
  return out;
}

export function cloneModel(model: VoxModelData): VoxModelData {
  const out: VoxModelData = {
    sizeX: model.sizeX,
    sizeY: model.sizeY,
    sizeZ: model.sizeZ,
    voxels: model.voxels.map(v => ({ ...v }))
  };
  if (model.palette) out.palette = new Uint32Array(model.palette);
  return out;
}

export function clearRegion(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
  model.voxels = model.voxels.filter(v => 
    v.x < minX || v.x > maxX || v.y < minY || v.y > maxY || v.z < minZ || v.z > maxZ
  );
}

export function copyRegion(model: VoxModelData, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Voxel[] {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
  return model.voxels
    .filter(v => v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY && v.z >= minZ && v.z <= maxZ)
    .map(v => ({ x: v.x - minX, y: v.y - minY, z: v.z - minZ, i: v.i }));
}

export function pasteRegion(model: VoxModelData, voxels: Voxel[], offsetX: number, offsetY: number, offsetZ: number) {
  for (const v of voxels) {
    const nx = v.x + offsetX, ny = v.y + offsetY, nz = v.z + offsetZ;
    if (nx >= 0 && nx < model.sizeX && ny >= 0 && ny < model.sizeY && nz >= 0 && nz < model.sizeZ) {
      model.voxels.push({ x: nx, y: ny, z: nz, i: v.i });
    }
  }
}

export function getModelInfo(model: VoxModelData): {
  size: [number, number, number];
  voxelCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  usedColors: number[];
} {
  let minX = model.sizeX, minY = model.sizeY, minZ = model.sizeZ;
  let maxX = 0, maxY = 0, maxZ = 0;
  const colorSet = new Set<number>();
  
  for (const v of model.voxels) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    colorSet.add(v.i);
  }
  
  return {
    size: [model.sizeX, model.sizeY, model.sizeZ],
    voxelCount: model.voxels.length,
    boundingBox: {
      min: model.voxels.length > 0 ? [minX, minY, minZ] : [0, 0, 0],
      max: model.voxels.length > 0 ? [maxX, maxY, maxZ] : [0, 0, 0]
    },
    usedColors: Array.from(colorSet).sort((a, b) => a - b)
  };
}

export function setVoxels(model: VoxModelData, voxels: Voxel[]) {
  for (const v of voxels) {
    if (v.x < 0 || v.x >= model.sizeX || v.y < 0 || v.y >= model.sizeY || v.z < 0 || v.z >= model.sizeZ) continue;
    model.voxels.push({ x: v.x, y: v.y, z: v.z, i: v.i });
  }
}

export function translate(model: VoxModelData, dx: number, dy: number, dz: number) {
  for (const v of model.voxels) {
    v.x = clamp(v.x + dx, 0, model.sizeX - 1);
    v.y = clamp(v.y + dy, 0, model.sizeY - 1);
    v.z = clamp(v.z + dz, 0, model.sizeZ - 1);
  }
}

export function rotate90(model: VoxModelData, axis: "x" | "y" | "z") {
  // Swap dimensions appropriately
  const oldSizeX = model.sizeX, oldSizeY = model.sizeY, oldSizeZ = model.sizeZ;
  
  for (const v of model.voxels) {
    const x = v.x, y = v.y, z = v.z;
    switch (axis) {
      case "x":
        v.y = oldSizeZ - 1 - z;
        v.z = y;
        break;
      case "y":
        v.x = z;
        v.z = oldSizeX - 1 - x;
        break;
      case "z":
        v.x = oldSizeY - 1 - y;
        v.y = x;
        break;
    }
  }
  
  // Update model dimensions
  switch (axis) {
    case "x":
      model.sizeY = oldSizeZ;
      model.sizeZ = oldSizeY;
      break;
    case "y":
      model.sizeX = oldSizeZ;
      model.sizeZ = oldSizeX;
      break;
    case "z":
      model.sizeX = oldSizeY;
      model.sizeY = oldSizeX;
      break;
  }
}

export function booleanOp(a: VoxModelData, b: VoxModelData, op: "union" | "intersect" | "difference"): VoxModelData {
  const key = (v: Voxel) => `${v.x},${v.y},${v.z}`;
  const setA = new Map<string, Voxel>();
  for (const v of a.voxels) setA.set(key(v), v);
  const setB = new Map<string, Voxel>();
  for (const v of b.voxels) setB.set(key(v), v);

  const out: VoxModelData = { sizeX: a.sizeX, sizeY: a.sizeY, sizeZ: a.sizeZ, voxels: [] };
  const add = (v: Voxel) => out.voxels.push({ x: v.x, y: v.y, z: v.z, i: v.i });

  if (op === "union") {
    setA.forEach(add);
    setB.forEach((v, k) => {
      if (!setA.has(k)) add(v);
    });
  } else if (op === "intersect") {
    setA.forEach((v, k) => {
      if (setB.has(k)) add(v);
    });
  } else if (op === "difference") {
    setA.forEach((v, k) => {
      if (!setB.has(k)) add(v);
    });
  }
  return out;
}

export function cropToContent(model: VoxModelData) {
  if (model.voxels.length === 0) return;
  let minX = model.sizeX, minY = model.sizeY, minZ = model.sizeZ, maxX = 0, maxY = 0, maxZ = 0;
  for (const v of model.voxels) { if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z; if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z; }
  const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1;
  const out: VoxModelData = { sizeX: nx, sizeY: ny, sizeZ: nz, voxels: [] } as any;
  if (model.palette) (out as any).palette = model.palette;
  for (const v of model.voxels) out.voxels.push({ x: v.x - minX, y: v.y - minY, z: v.z - minZ, i: v.i });
  model.sizeX = out.sizeX; model.sizeY = out.sizeY; model.sizeZ = out.sizeZ; model.voxels = out.voxels;
}

export function centerModel(model: VoxModelData) {
  const cx = Math.floor((model.sizeX - 1) / 2), cy = Math.floor((model.sizeY - 1) / 2), cz = Math.floor((model.sizeZ - 1) / 2);
  const info = getModelInfo(model);
  const bx = Math.floor((info.boundingBox.min[0] + info.boundingBox.max[0]) / 2);
  const by = Math.floor((info.boundingBox.min[1] + info.boundingBox.max[1]) / 2);
  const bz = Math.floor((info.boundingBox.min[2] + info.boundingBox.max[2]) / 2);
  translate(model, cx - bx, cy - by, cz - bz);
}

export function alignToGround(model: VoxModelData) {
  const info = getModelInfo(model);
  translate(model, 0, 0, -info.boundingBox.min[2]);
}

export function flipModel(model: VoxModelData, axis: "x" | "y" | "z") {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  for (const v of model.voxels) {
    if (axis === "x") v.x = (sx - 1) - v.x;
    else if (axis === "y") v.y = (sy - 1) - v.y;
    else v.z = (sz - 1) - v.z;
  }
}

export function rotateArbitrary(model: VoxModelData, axis: "x" | "y" | "z", degrees: number) {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (model.sizeX - 1) / 2, cy = (model.sizeY - 1) / 2, cz = (model.sizeZ - 1) / 2;
  for (const v of model.voxels) {
    const x = v.x - cx, y = v.y - cy, z = v.z - cz;
    if (axis === "z") {
      const nx = Math.round(x * cos - y * sin), ny = Math.round(x * sin + y * cos);
      v.x = clamp(Math.round(nx + cx), 0, model.sizeX - 1);
      v.y = clamp(Math.round(ny + cy), 0, model.sizeY - 1);
    } else if (axis === "y") {
      const nx = Math.round(x * cos + z * sin), nz = Math.round(-x * sin + z * cos);
      v.x = clamp(Math.round(nx + cx), 0, model.sizeX - 1);
      v.z = clamp(Math.round(nz + cz), 0, model.sizeZ - 1);
    } else {
      const ny = Math.round(y * cos - z * sin), nz = Math.round(y * sin + z * cos);
      v.y = clamp(Math.round(ny + cy), 0, model.sizeY - 1);
      v.z = clamp(Math.round(nz + cz), 0, model.sizeZ - 1);
    }
  }
}

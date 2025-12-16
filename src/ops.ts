import type { VoxModelData, Voxel } from "./vox.js";

function key(x: number, y: number, z: number) {
  return (x << 20) ^ (y << 10) ^ z;
}

// Simple noise functions
function hash(x: number, y: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return h ^ (h >> 16);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep(xf), v = smoothstep(yf);
  
  const n00 = (hash(xi, yi, seed) & 0xffff) / 0xffff;
  const n01 = (hash(xi, yi + 1, seed) & 0xffff) / 0xffff;
  const n10 = (hash(xi + 1, yi, seed) & 0xffff) / 0xffff;
  const n11 = (hash(xi + 1, yi + 1, seed) & 0xffff) / 0xffff;
  
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

function fbm(x: number, y: number, octaves: number, persistence: number, seed: number): number {
  let total = 0, amplitude = 1, maxValue = 0, frequency = 1;
  for (let i = 0; i < octaves; i++) {
    total += noise2D(x * frequency, y * frequency, seed + i * 1000) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }
  return total / maxValue;
}

export function deduplicateVoxels(model: VoxModelData) {
  const seen = new Map<number, Voxel>();
  for (const v of model.voxels) seen.set(key(v.x, v.y, v.z), v);
  model.voxels = Array.from(seen.values());
}

export function mirror(model: VoxModelData, axis: "x" | "y" | "z") {
  const mirrored: Voxel[] = [];
  const maxX = model.sizeX - 1;
  const maxY = model.sizeY - 1;
  const maxZ = model.sizeZ - 1;
  for (const v of model.voxels) {
    if (axis === "x") mirrored.push({ x: maxX - v.x, y: v.y, z: v.z, i: v.i });
    else if (axis === "y") mirrored.push({ x: v.x, y: maxY - v.y, z: v.z, i: v.i });
    else mirrored.push({ x: v.x, y: v.y, z: maxZ - v.z, i: v.i });
  }
  model.voxels.push(...mirrored);
}

export function hollow(model: VoxModelData, thickness = 1) {
  if (thickness <= 0) return;
  // Build occupancy grid
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = v.i;
  const out: Voxel[] = [];
  const dirs: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  function neighborEmptyWithinT(x: number, y: number, z: number) {
    for (const [dx, dy, dz] of dirs) {
      for (let t = 1; t <= thickness; t++) {
        const nx = x + dx * t,
          ny = y + dy * t,
          nz = z + dz * t;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) return true; // boundary -> exposed
        if (occ[idx(nx, ny, nz)] === 0) return true;
      }
    }
    return false;
  }
  for (const v of model.voxels) {
    if (neighborEmptyWithinT(v.x, v.y, v.z)) out.push(v);
  }
  model.voxels = out;
}

export function floodFill(model: VoxModelData, x: number, y: number, z: number, targetIndex: number, newIndex: number) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  const occ = new Int16Array(sx * sy * sz);
  occ.fill(-1);
  // Map voxels into occ (last assignment wins)
  for (let i = 0; i < model.voxels.length; i++) {
    const v = model.voxels[i]!;
    occ[idx(v.x, v.y, v.z)] = i;
  }
  const start = idx(x, y, z);
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
  const si = occ[start] as number;
  const cur = si >= 0 ? model.voxels[si]! .i : 0;
  if (cur !== targetIndex) return 0;
  const q = [[x, y, z]] as number[][];
  const seen = new Uint8Array(sx * sy * sz);
  seen[start] = 1;
  let changed = 0;
  while (q.length) {
    const node = q.pop() as number[];
    const cx = node[0]!;
    const cy = node[1]!;
    const cz = node[2]!;
    const id = idx(cx, cy, cz);
    const oi = occ[id] as number;
    if (oi >= 0 && model.voxels[oi]! .i === targetIndex) {
      model.voxels[oi]! .i = newIndex;
      changed++;
    }
    const nbrs = [
      [cx + 1, cy, cz],
      [cx - 1, cy, cz],
      [cx, cy + 1, cz],
      [cx, cy - 1, cz],
      [cx, cy, cz + 1],
      [cx, cy, cz - 1],
    ];
    for (const [nx, ny, nz] of nbrs as [number, number, number][]) {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const nid = idx(nx, ny, nz);
      if (seen[nid]) continue;
      const oi2 = occ[nid] as number;
      const color = oi2 >= 0 ? model.voxels[oi2]! .i : 0;
      if (color === targetIndex) {
        seen[nid] = 1;
        q.push([nx, ny, nz]);
      }
    }
  }
  return changed;
}

export function applyNoise(model: VoxModelData, scale: number, intensity: number, seed: number) {
  for (const v of model.voxels) {
    const n = noise2D(v.x / scale, v.y / scale, seed);
    const offset = Math.floor((n - 0.5) * 2 * intensity);
    v.z = Math.max(0, Math.min(model.sizeZ - 1, v.z + offset));
  }
}

export function generateTerrain(model: VoxModelData, opts: { octaves: number; persistence: number; scale: number; seed: number }) {
  const { octaves, persistence, scale, seed } = opts;
  model.voxels = [];
  
  for (let y = 0; y < model.sizeY; y++) {
    for (let x = 0; x < model.sizeX; x++) {
      const n = fbm(x / scale, y / scale, octaves, persistence, seed);
      const height = Math.floor(n * (model.sizeZ - 1));
      
      for (let z = 0; z <= height; z++) {
        // Color by height
        let colorIndex: number;
        if (z < height * 0.3) colorIndex = 100; // stone/brown
        else if (z < height * 0.7) colorIndex = 120; // dirt
        else if (z < height * 0.9) colorIndex = 80; // grass
        else colorIndex = 250; // snow/peak
        
        model.voxels.push({ x, y, z, i: colorIndex });
      }
    }
  }
}

export function generateTree(model: VoxModelData, baseX: number, baseY: number, baseZ: number, style: "oak" | "pine" | "palm", seed: number) {
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  
  const trunkColor = 60; // brown
  const leafColor = 80; // green
  
  if (style === "pine") {
    const height = 8 + Math.floor(rng() * 6);
    // Trunk
    for (let h = 0; h < height; h++) {
      const z = baseZ + h;
      if (z < model.sizeZ) model.voxels.push({ x: baseX, y: baseY, z, i: trunkColor });
    }
    // Cone-shaped leaves
    for (let h = 2; h < height; h++) {
      const r = Math.max(1, Math.floor((height - h) / 2));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) {
            const nx = baseX + dx, ny = baseY + dy, nz = baseZ + h;
            if (nx >= 0 && nx < model.sizeX && ny >= 0 && ny < model.sizeY && nz < model.sizeZ) {
              model.voxels.push({ x: nx, y: ny, z: nz, i: leafColor });
            }
          }
        }
      }
    }
  } else if (style === "palm") {
    const height = 6 + Math.floor(rng() * 4);
    // Curved trunk
    for (let h = 0; h < height; h++) {
      const z = baseZ + h;
      const bend = Math.floor(h / 3);
      const nx = baseX + bend;
      if (nx < model.sizeX && z < model.sizeZ) {
        model.voxels.push({ x: nx, y: baseY, z, i: trunkColor });
      }
    }
    // Palm fronds
    const topX = baseX + Math.floor(height / 3);
    const topZ = baseZ + height - 1;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      for (let d = 1; d <= 4; d++) {
        const nx = Math.round(topX + Math.cos(angle) * d);
        const ny = Math.round(baseY + Math.sin(angle) * d);
        const nz = topZ - Math.floor(d / 2);
        if (nx >= 0 && nx < model.sizeX && ny >= 0 && ny < model.sizeY && nz >= 0 && nz < model.sizeZ) {
          model.voxels.push({ x: nx, y: ny, z: nz, i: leafColor });
        }
      }
    }
  } else {
    // Oak (default)
    const height = 5 + Math.floor(rng() * 4);
    // Trunk
    for (let h = 0; h < height; h++) {
      const z = baseZ + h;
      if (z < model.sizeZ) model.voxels.push({ x: baseX, y: baseY, z, i: trunkColor });
    }
    // Spherical canopy
    const canopyR = 2 + Math.floor(rng() * 2);
    const canopyZ = baseZ + height;
    for (let dz = -canopyR; dz <= canopyR; dz++) {
      for (let dy = -canopyR; dy <= canopyR; dy++) {
        for (let dx = -canopyR; dx <= canopyR; dx++) {
          if (dx * dx + dy * dy + dz * dz <= canopyR * canopyR) {
            const nx = baseX + dx, ny = baseY + dy, nz = canopyZ + dz;
            if (nx >= 0 && nx < model.sizeX && ny >= 0 && ny < model.sizeY && nz >= 0 && nz < model.sizeZ) {
              model.voxels.push({ x: nx, y: ny, z: nz, i: leafColor });
            }
          }
        }
      }
    }
  }
}

export function replaceColor(model: VoxModelData, oldIndex: number, newIndex: number): number {
  let count = 0;
  for (const v of model.voxels) {
    if (v.i === oldIndex) {
      v.i = newIndex;
      count++;
    }
  }
  return count;
}

// ============== PATTERN / TEXTURE TOOLS ==============

export function applyPattern(model: VoxModelData, pattern: "checker" | "stripes" | "dots" | "gradient" | "noise" | "brick" | "wood" | "scales", colors: number[], scale: number) {
  const c = (k: number) => colors[Math.max(0, Math.min(colors.length - 1, k))] ?? 200;
  const s = Math.max(1, Math.floor(scale));
  for (const v of model.voxels) {
    const gx = Math.floor(v.x / s), gy = Math.floor(v.y / s), gz = Math.floor(v.z / s);
    switch (pattern) {
      case "checker": {
        const idx = (gx + gy + gz) & 1;
        v.i = c(idx);
        break;
      }
      case "stripes": {
        const idx = Math.abs(gx) % colors.length;
        v.i = c(idx);
        break;
      }
      case "dots": {
        const idx = ((gx % 4 === 0) && (gy % 4 === 0)) ? 1 : 0;
        v.i = c(idx);
        break;
      }
      case "gradient": {
        const t = Math.max(0, Math.min(1, v.z / Math.max(1, model.sizeZ - 1)));
        const a = c(0), b = c(colors.length - 1);
        v.i = t < 0.5 ? a : b;
        break;
      }
      case "noise": {
        const n = noise2D(v.x / s, v.y / s, 12345);
        v.i = c(Math.floor(n * colors.length));
        break;
      }
      case "brick": {
        const row = gy;
        const offset = (row & 1) ? 1 : 0;
        const col = (gx + offset) % 4;
        v.i = c(col === 0 ? 1 : 0);
        break;
      }
      case "wood": {
        const n = noise2D(v.x / (s * 2), v.y / (s * 2), 54321);
        v.i = c(n > 0.5 ? 1 : 0);
        break;
      }
      case "scales": {
        const idx = ((gx % 3) === 0 || (gy % 3) === 0) ? 1 : 0;
        v.i = c(idx);
        break;
      }
    }
  }
}

export function applyGradient(model: VoxModelData, axis: "x" | "y" | "z", i0: number, i1: number) {
  const max = axis === "x" ? model.sizeX - 1 : axis === "y" ? model.sizeY - 1 : model.sizeZ - 1;
  for (const v of model.voxels) {
    const pos = axis === "x" ? v.x : axis === "y" ? v.y : v.z;
    const t = max > 0 ? pos / max : 0;
    v.i = t < 0.5 ? i0 : i1;
  }
}

export function randomizeSurfaceColor(model: VoxModelData, delta: number) {
  // Mark surface voxels (having any empty neighbor)
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = v.i;
  for (const v of model.voxels) {
    const neighbors: [number, number, number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    let exposed = false;
    for (const [dx,dy,dz] of neighbors) {
      const nx = v.x + dx, ny = v.y + dy, nz = v.z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz || occ[idx(nx, ny, nz)] === 0) { exposed = true; break; }
    }
    if (exposed) v.i = Math.max(1, Math.min(255, v.i + Math.round((Math.random() * 2 - 1) * delta)));
  }
}

// ============== ADVANCED EDITING OPS ==============

export function erode(model: VoxModelData, iterations = 1) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (let it = 0; it < iterations; it++) {
    const occ = new Uint8Array(sx * sy * sz);
    for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = 1;
    const out: Voxel[] = [];
    for (const v of model.voxels) {
      let exposed = false;
      if (v.x === 0 || v.x === sx - 1 || v.y === 0 || v.y === sy - 1 || v.z === 0 || v.z === sz - 1) exposed = true;
      else if (!occ[idx(v.x + 1, v.y, v.z)] || !occ[idx(v.x - 1, v.y, v.z)] || !occ[idx(v.x, v.y + 1, v.z)] || !occ[idx(v.x, v.y - 1, v.z)] || !occ[idx(v.x, v.y, v.z + 1)] || !occ[idx(v.x, v.y, v.z - 1)]) exposed = true;
      if (!exposed) out.push(v);
    }
    model.voxels = out;
  }
}

export function dilate(model: VoxModelData, iterations = 1, i?: number) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (let it = 0; it < iterations; it++) {
    const occ = new Uint8Array(sx * sy * sz);
    for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = v.i;
    const add: Voxel[] = [];
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const o = occ[idx(x, y, z)];
          if (o) continue;
          const nbrs = [
            [x + 1, y, z],
            [x - 1, y, z],
            [x, y + 1, z],
            [x, y - 1, z],
            [x, y, z + 1],
            [x, y, z - 1],
          ];
          let found = 0, ci = i ?? 0;
          for (const [nx, ny, nz] of nbrs as [number, number, number][]) {
            if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
            const c = occ[idx(nx, ny, nz)];
            if (c) { found = 1; ci = ci || c; break; }
          }
          if (found) add.push({ x, y, z, i: ci || 200 });
        }
    model.voxels.push(...add);
  }
}

export function outline(model: VoxModelData) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  const occ = new Uint8Array(sx * sy * sz);
  for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = v.i;
  const out: Voxel[] = [];
  for (const v of model.voxels) {
    const nbrs: [number, number, number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    let exposed = false;
    for (const [dx,dy,dz] of nbrs) {
      const nx = v.x + dx, ny = v.y + dy, nz = v.z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz || occ[idx(nx, ny, nz)] === 0) { exposed = true; break; }
    }
    if (exposed) out.push(v);
  }
  model.voxels = out;
}

export function smoothModel(model: VoxModelData, iterations = 1) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (let it = 0; it < iterations; it++) {
    const occ = new Uint8Array(sx * sy * sz);
    for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = 1;
    const out: Voxel[] = [];
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          let count = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy, nz = z + dz;
                if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
                if (occ[idx(nx, ny, nz)]) count++;
              }
          if (count >= 14) out.push({ x, y, z, i: 150 });
        }
    model.voxels = out;
  }
}

export function extrudeFace(model: VoxModelData, axis: "x" | "y" | "z", amount: number, i?: number) {
  const dir = axis;
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Set(model.voxels.map(v => `${v.x},${v.y},${v.z}`));
  let frontier = model.voxels.filter(v => {
    const nbr = (dx: number, dy: number, dz: number) => !occ.has(`${v.x + dx},${v.y + dy},${v.z + dz}`);
    return dir === "x" ? nbr(1,0,0) : dir === "y" ? nbr(0,1,0) : nbr(0,0,1);
  });
  for (let step = 1; step <= amount; step++) {
    const next: Voxel[] = [];
    for (const v of frontier) {
      const nx = v.x + (dir === "x" ? 1 : 0);
      const ny = v.y + (dir === "y" ? 1 : 0);
      const nz = v.z + (dir === "z" ? 1 : 0);
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const keyStr = `${nx},${ny},${nz}`;
      if (occ.has(keyStr)) continue;
      const nv = { x: nx, y: ny, z: nz, i: i ?? v.i } as Voxel;
      model.voxels.push(nv);
      occ.add(keyStr);
      next.push(nv);
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
}

export function bevelEdges(model: VoxModelData) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  const occ = new Uint8Array(sx * sy * sz);
  for (const v of model.voxels) occ[idx(v.x, v.y, v.z)] = 1;
  const out: Voxel[] = [];
  for (const v of model.voxels) {
    let neighbors = 0;
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as [number,number,number][];
    for (const [dx,dy,dz] of dirs) {
      const nx = v.x + dx, ny = v.y + dy, nz = v.z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      if (occ[idx(nx, ny, nz)]) neighbors++;
    }
    if (neighbors >= 3) out.push(v);
  }
  model.voxels = out;
}

export function addDetailNoise(model: VoxModelData, scale: number, intensity: number, seed: number) {
  applyNoise(model, scale, intensity, seed);
}

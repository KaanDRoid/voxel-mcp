import fs from "fs";
import { PNG } from "pngjs";
import { defaultPalette, type VoxModelData } from "./vox.js";

interface Face {
  vertices: number[]; // indices into vertex array
  normal: [number, number, number];
}

/** Write a file inside an output folder without following an existing symlink entry. */
export function writeFileNoFollow(file: string, data: Uint8Array) {
  let existing: fs.Stats | undefined;
  try { existing = fs.lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${file}`);
  if (existing && !existing.isFile()) throw new Error(`refusing to overwrite non-file entry: ${file}`);
  if (existing) fs.unlinkSync(file);
  fs.writeFileSync(file, data, { flag: "wx" });
}

export function exportOBJ(model: VoxModelData, path: string) {
  // Build occupancy grid
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  
  for (const v of model.voxels) {
    if (v.x >= 0 && v.x < sx && v.y >= 0 && v.y < sy && v.z >= 0 && v.z < sz) {
      occ[idx(v.x, v.y, v.z)] = v.i;
    }
  }
  
  const vertices: [number, number, number, number][] = [];
  const faces: { verts: number[]; color: number }[] = [];
  const vertexMap = new Map<string, number>();
  
  function getVertex(x: number, y: number, z: number, color: number): number {
    const key = `${x},${y},${z},${color}`;
    if (vertexMap.has(key)) return vertexMap.get(key)!;
    const idx = vertices.length;
    vertices.push([x, y, z, color]);
    vertexMap.set(key, idx);
    return idx;
  }
  
  // For each voxel, check 6 faces and emit only exposed faces
  const dirs: [number, number, number, [number, number, number][]][] = [
    // +X face
    [1, 0, 0, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    // -X face
    [-1, 0, 0, [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]]],
    // +Y face
    [0, 1, 0, [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]]],
    // -Y face
    [0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    // +Z face
    [0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    // -Z face
    [0, 0, -1, [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]]],
  ];
  
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const color = occ[idx(x, y, z)];
        if (color === 0) continue;
        
        for (const [dx, dy, dz, corners] of dirs) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          const neighborEmpty = nx < 0 || ny < 0 || nz < 0 || 
                                nx >= sx || ny >= sy || nz >= sz || 
                                occ[idx(nx, ny, nz)] === 0;
          
          if (neighborEmpty) {
            const faceVerts = corners.map(([cx, cy, cz]) => 
              getVertex(x + cx, y + cy, z + cz, color!)
            );
            faces.push({ verts: faceVerts, color: color as number });
          }
        }
      }
    }
  }
  
  // Generate OBJ content
  let obj = "# Voxel surface; vertex RGB extension (no external material files)\n";
  obj += `# Vertices: ${vertices.length}, Faces: ${faces.length}\n\n`;
  
  // Vertices
  const palette = model.palette ?? defaultPalette();
  for (const [x, y, z, color] of vertices) {
    const c = palette[color] ?? 0;
    obj += `v ${x} ${z} ${y} ${((c>>>16)&255)/255} ${((c>>>8)&255)/255} ${(c&255)/255}\n`;
  }
  
  obj += "\n";
  
  // Faces (OBJ uses 1-based indexing)
  for (const face of faces) {
    obj += `f ${face.verts.slice().reverse().map(v => v + 1).join(" ")}\n`;
  }
  
  fs.writeFileSync(path, obj);
}

export function exportPLY(model: VoxModelData, path: string) {
  // Point cloud export
  const points: { x: number; y: number; z: number; r: number; g: number; b: number }[] = [];
  
  const palette = model.palette ?? defaultPalette();
  for (const v of model.voxels) {
    if (v.i <= 0 || v.x < 0 || v.x >= model.sizeX || v.y < 0 || v.y >= model.sizeY || v.z < 0 || v.z >= model.sizeZ) continue;
    const rgba = palette[v.i] ?? 0;
    const r = (rgba >>> 16) & 255, g = (rgba >>> 8) & 255, b = rgba & 255;
    points.push({ x: v.x, y: v.y, z: v.z, r, g, b });
  }
  
  let ply = "ply\n";
  ply += "format ascii 1.0\n";
  ply += `element vertex ${points.length}\n`;
  ply += "property float x\n";
  ply += "property float y\n";
  ply += "property float z\n";
  ply += "property uchar red\n";
  ply += "property uchar green\n";
  ply += "property uchar blue\n";
  ply += "end_header\n";
  
  for (const p of points) {
    ply += `${p.x} ${p.z} ${p.y} ${p.r} ${p.g} ${p.b}\n`;
  }
  
  fs.writeFileSync(path, ply);
}

export function exportSlices(model: VoxModelData, folder: string) {
  const palette = model.palette ?? defaultPalette();
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  
  // Build occupancy grid
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) {
    if (v.x >= 0 && v.x < sx && v.y >= 0 && v.y < sy && v.z >= 0 && v.z < sz) {
      occ[idx(v.x, v.y, v.z)] = v.i;
    }
  }
  
  fs.mkdirSync(folder, { recursive: true });
  
  for (let z = 0; z < sz; z++) {
    const png = new PNG({ width: sx, height: sy });
    
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const color = occ[idx(x, y, z)];
        const pngIdx = (y * sx + x) * 4;
        
        if (color === 0) {
          png.data[pngIdx + 0] = 0;
          png.data[pngIdx + 1] = 0;
          png.data[pngIdx + 2] = 0;
          png.data[pngIdx + 3] = 0;
        } else {
          const rgba = palette[color as number] ?? 0;
          png.data[pngIdx + 0] = (rgba >>> 16) & 0xff;
          png.data[pngIdx + 1] = (rgba >>> 8) & 0xff;
          png.data[pngIdx + 2] = rgba & 0xff;
          png.data[pngIdx + 3] = (rgba >>> 24) & 0xff;
        }
      }
    }
    
    const buf = PNG.sync.write(png);
    writeFileNoFollow(`${folder}/slice_${String(z).padStart(4, "0")}.png`, buf);
  }
}

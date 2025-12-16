import fs from "fs";
import type { VoxModelData } from "./vox.js";

export function exportSTL(model: VoxModelData, path: string) {
  // ASCII STL of exposed faces (each quad -> 2 triangles)
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) if (v.x>=0&&v.x<sx&&v.y>=0&&v.y<sy&&v.z>=0&&v.z<sz) occ[idx(v.x,v.y,v.z)] = 1;
  const lines: string[] = ["solid vox"];
  const dirs: [number, number, number, [number, number, number][]][] = [
    [1, 0, 0, [[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],
    [-1,0,0, [[0,1,0],[0,0,0],[0,0,1],[0,1,1]]],
    [0, 1, 0, [[1,1,0],[0,1,0],[0,1,1],[1,1,1]]],
    [0,-1, 0, [[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],
    [0, 0, 1, [[0,0,1],[1,0,1],[1,1,1],[0,1,1]]],
    [0, 0,-1, [[0,1,0],[1,1,0],[1,0,0],[0,0,0]]],
  ];
  function facet(n:[number,number,number], a:number[], b:number[], c:number[]) {
    lines.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
    lines.push("    outer loop");
    lines.push(`      vertex ${a[0]} ${a[2]} ${a[1]}`);
    lines.push(`      vertex ${b[0]} ${b[2]} ${b[1]}`);
    lines.push(`      vertex ${c[0]} ${c[2]} ${c[1]}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  for (let z=0; z<sz; z++) for (let y=0; y<sy; y++) for (let x=0; x<sx; x++) {
    if (!occ[idx(x,y,z)]) continue;
    for (const [dx,dy,dz,corners] of dirs) {
      const nx=x+dx, ny=y+dy, nz=z+dz;
      const empty = nx<0||ny<0||nz<0||nx>=sx||ny>=sy||nz>=sz||!occ[idx(nx,ny,nz)];
      if (!empty) continue;
      const v0 = [x+corners[0]![0], y+corners[0]![1], z+corners[0]![2]];
      const v1 = [x+corners[1]![0], y+corners[1]![1], z+corners[1]![2]];
      const v2 = [x+corners[2]![0], y+corners[2]![1], z+corners[2]![2]];
      const v3 = [x+corners[3]![0], y+corners[3]![1], z+corners[3]![2]];
      facet([dx,dy,dz], v0, v1, v2);
      facet([dx,dy,dz], v0, v2, v3);
    }
  }
  lines.push("endsolid vox");
  fs.writeFileSync(path, lines.join("\n"));
}

export function exportGLTF(model: VoxModelData, path: string) {
  // Minimal glTF 2.0 with embedded base64 buffers, triangulated faces
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) if (v.x>=0&&v.x<sx&&v.y>=0&&v.y<sy&&v.z>=0&&v.z<sz) occ[idx(v.x,v.y,v.z)] = 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const dirs: [number, number, number, [number, number, number][]][] = [
    [1, 0, 0, [[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],
    [-1,0,0, [[0,1,0],[0,0,0],[0,0,1],[0,1,1]]],
    [0, 1, 0, [[1,1,0],[0,1,0],[0,1,1],[1,1,1]]],
    [0,-1, 0, [[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],
    [0, 0, 1, [[0,0,1],[1,0,1],[1,1,1],[0,1,1]]],
    [0, 0,-1, [[0,1,0],[1,1,0],[1,0,0],[0,0,0]]],
  ];
  const vertMap = new Map<string, number>();
  const addV = (x:number,y:number,z:number) => { const key=`${x},${y},${z}`; if (vertMap.has(key)) return vertMap.get(key)!; const i=positions.length/3; positions.push(x, z, y); vertMap.set(key, i); return i; };
  for (let z=0; z<sz; z++) for (let y=0; y<sy; y++) for (let x=0; x<sx; x++) {
    if (!occ[idx(x,y,z)]) continue;
    for (const [dx,dy,dz,corners] of dirs) {
      const nx=x+dx, ny=y+dy, nz=z+dz;
      const empty = nx<0||ny<0||nz<0||nx>=sx||ny>=sy||nz>=sz||!occ[idx(nx,ny,nz)];
      if (!empty) continue;
      const v0 = addV(x+corners[0]![0], y+corners[0]![1], z+corners[0]![2]);
      const v1 = addV(x+corners[1]![0], y+corners[1]![1], z+corners[1]![2]);
      const v2 = addV(x+corners[2]![0], y+corners[2]![1], z+corners[2]![2]);
      const v3 = addV(x+corners[3]![0], y+corners[3]![1], z+corners[3]![2]);
      indices.push(v0, v1, v2, v0, v2, v3);
    }
  }
  const posBuf = Buffer.from(new Float32Array(positions).buffer);
  const idxBuf = Buffer.from(new Uint32Array(indices).buffer);
  const b64 = (b:Buffer) => `data:application/octet-stream;base64,${b.toString("base64")}`;
  const json:any = {
    asset: { version: "2.0" },
    buffers: [ { byteLength: posBuf.length + idxBuf.length } ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length/3, type: "VEC3", min: [0,0,0], max: [model.sizeX, model.sizeZ, model.sizeY] },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
    meshes: [ { primitives: [ { attributes: { POSITION: 0 }, indices: 1 } ] } ],
    nodes: [ { mesh: 0 } ],
    scenes: [ { nodes: [0] } ],
    scene: 0,
  };
  // Embed buffers via separate .bin data URIs
  (json as any)._embedded = { pos: b64(posBuf), idx: b64(idxBuf) };
  // Consumers must rewrite buffer URIs; we inline via data URIs for simplicity
  json.buffers = [ { byteLength: posBuf.length, uri: (json as any)._embedded.pos }, { byteLength: idxBuf.length, uri: (json as any)._embedded.idx } ];
  json.bufferViews[1]!.buffer = 1;
  fs.writeFileSync(path, JSON.stringify(json));
}

export function exportMinecraftSchematic(model: VoxModelData, path: string) {
  // Minimal JSON schematic (not official NBT), contains size and palette index grid
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const grid = Array.from({ length: sz }, () => Array.from({ length: sy }, () => new Uint8Array(sx)));
  for (const v of model.voxels) { if (v.x>=0&&v.x<sx&&v.y>=0&&v.y<sy&&v.z>=0&&v.z<sz) grid[v.z]![v.y]![v.x] = v.i & 0xff; }
  const out = { width: sx, length: sy, height: sz, paletteIndices: grid.map(layer => Array.from(layer).map(row => Array.from(row))) };
  fs.writeFileSync(path, JSON.stringify(out));
}


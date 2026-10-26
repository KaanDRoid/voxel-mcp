import fs from "fs";
import { gzipSync } from "node:zlib";
import { defaultPalette, type VoxModelData } from "./vox.js";
import { buildQuads } from "./formats/mesh.js";
import { fmt, makeTransform } from "./formats/axes.js";
import { unpackRGBA } from "./color.js";

export interface MeshOptions {
  /** Output units per voxel edge (default 1). */
  scale?: number | undefined;
  /** Output axes; STL defaults to "XYZ" (Z up), glTF to "XZ-Y" (Y up). */
  axis?: string | undefined;
  /** Merge coplanar faces of the same color (default off). */
  merge?: boolean | undefined;
}

/** ASCII STL of exposed faces (each quad becomes two triangles), Z-up by default. */
export function exportSTL(model: VoxModelData, path: string, opts: MeshOptions = {}) {
  const t = makeTransform({ axis: opts.axis, scale: opts.scale }, "XYZ");
  const lines: string[] = ["solid vox"];
  const facet = (n: number[], a: number[], b: number[], c: number[]) => {
    lines.push(`  facet normal ${n.map(fmt).join(" ")}`, "    outer loop");
    for (const p of [a, b, c]) lines.push(`      vertex ${p.map(fmt).join(" ")}`);
    lines.push("    endloop", "  endfacet");
  };
  for (const q of buildQuads(model, opts.merge ?? false)) {
    const [c0, c1, c2, c3] = q.corners.map(c => t.point(c)) as unknown as [number[], number[], number[], number[]];
    const n = t.direction(q.normal);
    if (t.flip) { facet(n, c0, c2, c1); facet(n, c0, c3, c2); } else { facet(n, c0, c1, c2); facet(n, c0, c2, c3); }
  }
  lines.push("endsolid vox");
  fs.writeFileSync(path, lines.join("\n"));
}

/** glTF 2.0 with an embedded buffer, one material per palette color; Y-up by default (glTF convention). */
export function exportGLTF(model: VoxModelData, path: string, opts: MeshOptions = {}) {
  const t = makeTransform({ axis: opts.axis, scale: opts.scale }, "XZ-Y");
  const positions: number[] = [], normals: number[] = [];
  const groups = new Map<number, number[]>();
  for (const q of buildQuads(model, opts.merge ?? false)) {
    const base = positions.length / 3;
    const n = t.direction(q.normal);
    for (const c of q.corners) { positions.push(...t.point(c)); normals.push(...n); }
    let indices = groups.get(q.color);
    if (!indices) { indices = []; groups.set(q.color, indices); }
    if (t.flip) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (!positions.length) {
    fs.writeFileSync(path, JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0 }));
    return;
  }
  const indices = [...groups.values()].flat();
  const floats = (data: number[]) => { const b = Buffer.alloc(data.length * 4); data.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
  const posBuf = floats(positions), normalBuf = floats(normals), indexBuf = Buffer.alloc(indices.length * 4);
  indices.forEach((v, i) => indexBuf.writeUInt32LE(v, i * 4));
  const binary = Buffer.concat([posBuf, normalBuf, indexBuf]);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3, f = Math.fround(positions[i]!);
    min[axis] = Math.min(min[axis]!, f); max[axis] = Math.max(max[axis]!, f);
  }
  const accessors: object[] = [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
  ];
  const palette = model.palette ?? defaultPalette();
  const linear = (byte: number) => { const c = byte / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const materials: object[] = [], primitives: object[] = [];
  let offset = 0;
  for (const [color, group] of groups) {
    const c = unpackRGBA(palette[color] ?? 0xffffffff);
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [linear(c.r), linear(c.g), linear(c.b), c.a / 255], metallicFactor: 0, roughnessFactor: 1 }, alphaMode: c.a < 255 ? "BLEND" : "OPAQUE" });
    const index = accessors.length;
    accessors.push({ bufferView: 2, byteOffset: offset, componentType: 5125, count: group.length, type: "SCALAR" });
    offset += group.length * 4;
    primitives.push({ attributes: { POSITION: 0, NORMAL: 1 }, indices: index, material: materials.length - 1, mode: 4 });
  }
  const gltf = {
    asset: { version: "2.0" }, buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 }, { buffer: 0, byteOffset: posBuf.length, byteLength: normalBuf.length, target: 34962 }, { buffer: 0, byteOffset: posBuf.length + normalBuf.length, byteLength: indexBuf.length, target: 34963 }],
    accessors, materials, meshes: [{ primitives }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  fs.writeFileSync(path, JSON.stringify(gltf));
}

/** Legacy MCEdit/WorldEdit Alpha .schematic (gzip NBT), not Sponge .schem (see formats/schem.ts).
 * Vox Z becomes Minecraft Y; opaque colors map to the closest of 16 wool dyes.
 * Air remains air; entities, block states and original palette indices are not retained.
 */
export function exportMinecraftSchematic(model: VoxModelData, path: string) {
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  if (![sx, sy, sz].every(n => Number.isInteger(n) && n > 0 && n <= 32767)) throw new Error("schematic dimensions must be 1..32767");
  const volume = sx * sy * sz;
  if (!Number.isSafeInteger(volume) || volume > 0x7fffffff) throw new Error("schematic volume too large");
  const blocks = Buffer.alloc(volume), data = Buffer.alloc(volume), palette = model.palette ?? defaultPalette();
  const wool = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];
  const nearest = (c: number) => {
    const p = unpackRGBA(c);
    let best = 0, distance = Infinity;
    wool.forEach((w, i) => {
      const d = (p.r - ((w >>> 16) & 255)) ** 2 + (p.g - ((w >>> 8) & 255)) ** 2 + (p.b - (w & 255)) ** 2;
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  };
  for (const v of model.voxels) {
    if (v.i <= 0 || ![v.x, v.y, v.z].every(Number.isInteger) || v.x < 0 || v.x >= sx || v.y < 0 || v.y >= sy || v.z < 0 || v.z >= sz) continue;
    const c = palette[v.i] ?? 0, idx = (v.z * sy + v.y) * sx + v.x;
    blocks[idx] = (c >>> 24) < 128 ? 0 : 35; data[idx] = blocks[idx] ? nearest(c) : 0;
  }
  const str = (value: string) => { const b = Buffer.from(value, "utf8"), len = Buffer.alloc(2); len.writeUInt16BE(b.length); return Buffer.concat([len, b]); };
  const tag = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), str(name), payload]);
  const short = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const array = (b: Buffer) => { const len = Buffer.alloc(4); len.writeInt32BE(b.length); return Buffer.concat([len, b]); };
  const nbt = tag(10, "Schematic", Buffer.concat([
    tag(2, "Width", short(sx)), tag(2, "Height", short(sz)), tag(2, "Length", short(sy)),
    tag(8, "Materials", str("Alpha")), tag(7, "Blocks", array(blocks)), tag(7, "Data", array(data)),
    tag(9, "Entities", Buffer.from([10, 0, 0, 0, 0])), tag(9, "TileEntities", Buffer.from([10, 0, 0, 0, 0])), Buffer.from([0]),
  ]));
  fs.writeFileSync(path, gzipSync(nbt));
}

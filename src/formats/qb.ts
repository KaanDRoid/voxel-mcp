import type { VoxModelData } from "../vox.js";
import { checkDims, checkVoxelBudget, indexColors, modelColors } from "./common.js";

/** Qubicle Binary (.qb), documented layout (unverified against Qubicle itself):
 *   u32 version (0x00000101), u32 colorFormat (0 RGBA, 1 BGRA), u32 zAxisOrientation (0 left, 1 right handed),
 *   u32 compressed, u32 visibilityMaskEncoded, u32 matrixCount, then per matrix:
 *   u8 nameLength, name, u32 sizeX/Y/Z, i32 posX/Y/Z, voxel data (z slice, y row, x column; 4 bytes each,
 *   alpha 0 = empty). Compressed data is RLE per z slice: 6 = next slice, 2 = run (count, color), else one voxel.
 * Qubicle is Y-up: voxel (x, y, z) is written as qb (x, z, y) with the left-handed flag, which keeps the shape
 * unmirrored. Right-handed files are mirrored back on import. */
const NEXT_SLICE = 6, RUN = 2;

export interface QbWriteOptions { compress?: boolean | undefined; colorFormat?: "rgba" | "bgra" | undefined }

export function encodeQB(model: VoxModelData, opts: QbWriteOptions = {}): Buffer {
  checkDims(model.sizeX, model.sizeY, model.sizeZ, "QB export");
  const bgra = opts.colorFormat === "bgra";
  const sx = model.sizeX, sy = model.sizeZ, sz = model.sizeY; // qb sizes: x, y (up), z
  const colorOf = modelColors(model);
  const cells = new Uint32Array(sx * sy * sz); // 0 = empty, else little-endian 4 byte color
  for (const v of model.voxels) {
    if (v.i < 1 || v.x < 0 || v.y < 0 || v.z < 0 || v.x >= model.sizeX || v.y >= model.sizeY || v.z >= model.sizeZ) continue;
    const c = colorOf(v.i);
    const bytes = bgra ? [c.b, c.g, c.r, 255] : [c.r, c.g, c.b, 255];
    cells[v.x + sx * (v.z + sy * v.y)] = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
  }
  const name = Buffer.from("Model", "latin1");
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0x101, 0); head.writeUInt32LE(bgra ? 1 : 0, 4); head.writeUInt32LE(0, 8);
  head.writeUInt32LE(opts.compress ? 1 : 0, 12); head.writeUInt32LE(0, 16); head.writeUInt32LE(1, 20);
  const matrix = Buffer.alloc(1 + name.length + 24);
  matrix[0] = name.length; name.copy(matrix, 1);
  [sx, sy, sz].forEach((n, i) => matrix.writeUInt32LE(n, 1 + name.length + i * 4));
  const out: Buffer[] = [head, matrix];
  if (!opts.compress) {
    const raw = Buffer.alloc(cells.length * 4);
    cells.forEach((c, i) => raw.writeUInt32LE(c, i * 4));
    out.push(raw);
  } else {
    const words: number[] = [];
    for (let z = 0; z < sz; z++) {
      const base = z * sx * sy, count = sx * sy;
      for (let i = 0; i < count;) {
        let run = 1;
        while (i + run < count && cells[base + i + run] === cells[base + i]) run++;
        if (run > 2) { words.push(RUN, run, cells[base + i]!); i += run; } else { words.push(cells[base + i]!); i++; }
      }
      words.push(NEXT_SLICE);
    }
    const rle = Buffer.alloc(words.length * 4);
    words.forEach((w, i) => rle.writeUInt32LE(w >>> 0, i * 4));
    out.push(rle);
  }
  return Buffer.concat(out);
}

interface Matrix { x: number; y: number; z: number; px: number; py: number; pz: number; cells: Uint32Array }

export function decodeQB(buf: Buffer): { model: VoxModelData; warnings: string[] } {
  if (buf.length < 24 || buf.readUInt32LE(0) !== 0x101) throw new Error("Not a QB file (unsupported or missing version header)");
  const colorFormat = buf.readUInt32LE(4), orientation = buf.readUInt32LE(8), compressed = buf.readUInt32LE(12), count = buf.readUInt32LE(20);
  if (colorFormat > 1 || orientation > 1 || compressed > 1) throw new Error("QB header contains unsupported flag values");
  if (count < 1 || count > 256) throw new Error("QB matrix count must be 1..256");
  let p = 24;
  const need = (n: number) => { if (p + n > buf.length) throw new Error("QB file is truncated"); };
  const matrices: Matrix[] = [];
  let totalCells = 0;
  for (let m = 0; m < count; m++) {
    need(1); const nameLen = buf[p++]!; need(nameLen + 24); p += nameLen;
    const x = buf.readUInt32LE(p), y = buf.readUInt32LE(p + 4), z = buf.readUInt32LE(p + 8);
    const px = buf.readInt32LE(p + 12), py = buf.readInt32LE(p + 16), pz = buf.readInt32LE(p + 20);
    p += 24;
    checkDims(x, y, z, "QB matrix");
    totalCells += x * y * z;
    checkVoxelBudget(totalCells, "QB file");
    const cells = new Uint32Array(x * y * z);
    if (!compressed) {
      need(cells.length * 4);
      for (let i = 0; i < cells.length; i++) cells[i] = buf.readUInt32LE(p + i * 4);
      p += cells.length * 4;
    } else {
      for (let slice = 0; slice < z; slice++) {
        let index = 0;
        for (;;) {
          need(4); const word = buf.readUInt32LE(p); p += 4;
          if (word === NEXT_SLICE) break;
          let value = word, repeat = 1;
          if (word === RUN) { need(8); repeat = buf.readUInt32LE(p); value = buf.readUInt32LE(p + 4); p += 8; }
          if (index + repeat > x * y) throw new Error("QB run exceeds the slice size");
          for (let k = 0; k < repeat; k++) cells[slice * x * y + index++] = value;
        }
      }
    }
    matrices.push({ x, y, z, px, py, pz, cells });
  }
  // Global extent in qb space, then map to voxel space (x, y, z) = (qb x, qb z, qb y).
  const right = orientation === 1;
  const minX = Math.min(...matrices.map(m => m.px)), minY = Math.min(...matrices.map(m => m.py)), minZ = Math.min(...matrices.map(m => m.pz));
  const maxX = Math.max(...matrices.map(m => m.px + m.x - 1)), maxY = Math.max(...matrices.map(m => m.py + m.y - 1)), maxZ = Math.max(...matrices.map(m => m.pz + m.z - 1));
  const sizeX = maxX - minX + 1, sizeY = maxZ - minZ + 1, sizeZ = maxY - minY + 1;
  checkDims(sizeX, sizeY, sizeZ, "QB scene");
  const histogram = new Map<number, number>();
  const found: { x: number; y: number; z: number; key: number }[] = [];
  for (const m of matrices) {
    for (let z = 0; z < m.z; z++) for (let y = 0; y < m.y; y++) for (let x = 0; x < m.x; x++) {
      const word = m.cells[x + m.x * (y + m.y * z)]!;
      if ((word >>> 24) === 0) continue;
      const r = colorFormat === 1 ? (word >>> 16) & 255 : word & 255, g = (word >>> 8) & 255, b = colorFormat === 1 ? word & 255 : (word >>> 16) & 255;
      const key = (r << 16) | (g << 8) | b;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      const gz = m.pz + z;
      found.push({ x: m.px + x - minX, y: right ? maxZ - gz : gz - minZ, z: m.py + y - minY, key });
    }
  }
  const colors = indexColors(histogram, "QB import");
  const seen = new Set<number>();
  const model: VoxModelData = { sizeX, sizeY, sizeZ, voxels: [], palette: colors.palette };
  for (const f of found) {
    const slot = f.x + sizeX * (f.y + sizeY * f.z);
    if (seen.has(slot)) continue;
    seen.add(slot);
    model.voxels.push({ x: f.x, y: f.y, z: f.z, i: colors.indexOf((f.key >>> 16) & 255, (f.key >>> 8) & 255, f.key & 255) });
  }
  return { model, warnings: colors.warnings };
}

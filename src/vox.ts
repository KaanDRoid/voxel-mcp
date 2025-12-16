// Minimal VOX v150 writer/reader (SIZE, XYZI, RGBA)
import fs from "fs";

export type Voxel = { x: number; y: number; z: number; i: number };

export interface VoxModelData {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  voxels: Voxel[];
  palette?: Uint32Array; // ARGB
}

function writeUInt32LE(buf: Buffer, val: number, off: number) {
  buf.writeUInt32LE(val >>> 0, off);
}

function chunk(id: string, content: Buffer, children?: Buffer[]): Buffer {
  const childSize = (children || []).reduce((a, b) => a + b.length, 0);
  const header = Buffer.alloc(12);
  header.write(id, 0, 4, "ascii");
  writeUInt32LE(header, content.length, 4);
  writeUInt32LE(header, childSize, 8);
  return Buffer.concat([header, content, ...(children || [])]);
}

export function encodeVOX(m: VoxModelData): Buffer {
  const header = Buffer.alloc(8);
  header.write("VOX ", 0, 4, "ascii");
  writeUInt32LE(header, 150, 4);

  // SIZE chunk
  const sizeC = Buffer.alloc(12);
  writeUInt32LE(sizeC, m.sizeX, 0);
  writeUInt32LE(sizeC, m.sizeY, 4);
  writeUInt32LE(sizeC, m.sizeZ, 8);
  const SIZE = chunk("SIZE", sizeC);

  // XYZI chunk
  const n = m.voxels.length;
  const xyziC = Buffer.alloc(4 + 4 * n);
  writeUInt32LE(xyziC, n, 0);
  for (let i = 0; i < n; i++) {
    const v = m.voxels[i]!;
    xyziC[4 + i * 4 + 0] = v.x & 0xff;
    xyziC[4 + i * 4 + 1] = v.y & 0xff;
    xyziC[4 + i * 4 + 2] = v.z & 0xff;
    xyziC[4 + i * 4 + 3] = v.i & 0xff; // palette index 1..255, 0 unused
  }
  const XYZI = chunk("XYZI", xyziC);

  const defaultPal = defaultPalette();
  const pal = m.palette ?? defaultPal;
  let rgbaChunk: Buffer | null = null;
  if (!equalPalette(pal, defaultPal)) {
    const rgbaC = Buffer.alloc(4 * 256);
    for (let i = 0; i < 256; i++) {
      const val = (pal as any)[i] ?? 0;
      writeUInt32LE(rgbaC, (val as number) >>> 0, i * 4);
    }
    rgbaChunk = chunk("RGBA", rgbaC);
  }

  const children = [SIZE, XYZI, ...(rgbaChunk ? [rgbaChunk] : [])];
  const MAIN = chunk("MAIN", Buffer.alloc(0), children);
  return Buffer.concat([header, MAIN]);
}

export function saveVOX(path: string, m: VoxModelData) {
  fs.writeFileSync(path, encodeVOX(m));
}

export function loadVOX(path: string): VoxModelData {
  const buf = fs.readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "VOX ") throw new Error("Not a VOX file");
  const version = buf.readUInt32LE(4);
  if (version !== 150) throw new Error(`Unsupported VOX version ${version}`);
  let off = 8;
  let sizeX = 0,
    sizeY = 0,
    sizeZ = 0;
  const voxels: Voxel[] = [];
  let palette: Uint32Array | undefined;

  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const content = buf.readUInt32LE(off + 4);
    const children = buf.readUInt32LE(off + 8);
    const cStart = off + 12;
    if (id === "SIZE") {
      sizeX = buf.readUInt32LE(cStart + 0);
      sizeY = buf.readUInt32LE(cStart + 4);
      sizeZ = buf.readUInt32LE(cStart + 8);
    } else if (id === "XYZI") {
      const n = buf.readUInt32LE(cStart + 0);
      for (let i = 0; i < n; i++) {
        const base = cStart + 4 + i * 4;
        voxels.push({ x: buf.readUInt8(base + 0), y: buf.readUInt8(base + 1), z: buf.readUInt8(base + 2), i: buf.readUInt8(base + 3) });
      }
    } else if (id === "RGBA") {
      const pal = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        pal[i] = buf.readUInt32LE(cStart + i * 4) >>> 0;
      }
      palette = pal;
    }
    off = cStart + content + children;
  }

  const out: VoxModelData = { sizeX, sizeY, sizeZ, voxels };
  if (palette) (out as any).palette = palette;
  return out;
}

export function defaultPalette(): Uint32Array {
  // Default MagicaVoxel palette (RGBA order in file, but VOX stores as ABGR little-endian); here we treat as LE u32
  // For simplicity, use a simple grayscale ramp; users can supply custom RGBA via tools.
  const pal = new Uint32Array(256);
  pal[0] = 0x00000000; // unused
  for (let i = 1; i < 256; i++) {
    const v = i;
    const rgba = (0xff << 24) | (v << 16) | (v << 8) | v;
    pal[i] = rgba >>> 0;
  }
  return pal;
}

function equalPalette(a: Uint32Array, b: Uint32Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

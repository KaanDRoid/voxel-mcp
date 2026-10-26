import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

interface PngLimits { maxPixels?: number; minPixels?: number; maxInputBytes?: number }

/** Validate dimensions and the complete inflated scanline budget before calling the image decoder. */
export function readPngBounded(bytes: Buffer, limits: PngLimits = {}): ReturnType<typeof PNG.sync.read> {
  if (bytes.length > (limits.maxInputBytes ?? 32 * 1024 * 1024)) throw new Error("PNG input size limit exceeded");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid PNG signature or header");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const pixels = width * height;
  if (!width || !height || pixels > (limits.maxPixels ?? 4 * 1024 * 1024) || pixels < (limits.minPixels ?? 1)) throw new Error(`PNG dimensions exceed the pixel limit (${limits.minPixels ?? 1}..${limits.maxPixels ?? 4 * 1024 * 1024})`);
  const depth = bytes[24]!, color = bytes[25]!, interlace = bytes[28]!;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const validDepth = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!channels || !validDepth.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw new Error("Unsupported PNG header");
  const scanlines = (w: number, h: number) => w > 0 && h > 0 ? (Math.ceil(w * channels * depth / 8) + 1) * h : 0;
  const expected = interlace === 0 ? scanlines(width, height) : ADAM7.reduce((sum, [x, y, dx, dy]) => sum + scanlines(Math.max(0, Math.ceil((width - x) / dx)), Math.max(0, Math.ceil((height - y) / dy))), 0);
  const compressed: Buffer[] = [];
  let offset = 8, chunks = 0, palettes = 0, ended = false;
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) throw new Error("PNG chunk count or size limit exceeded");
    const length = bytes.readUInt32BE(offset), next = offset + length + 12;
    if (next > bytes.length) throw new Error("Truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR" && offset !== 8) throw new Error("Duplicate PNG header");
    if (type === "PLTE") {
      if (palettes++) throw new Error("Duplicate PNG palette");
      if (!length || length > 768 || length % 3) throw new Error("Invalid PNG palette size (expected 1..256 RGB entries)");
    }
    if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset = next;
    if (type === "IEND") { if (length !== 0 || offset !== bytes.length) throw new Error("Invalid PNG end chunk"); ended = true; break; }
  }
  if (!ended || !compressed.length) throw new Error("Incomplete PNG image");
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); }
  catch { throw new Error("Decompressed PNG size limit exceeded or invalid compressed data"); }
  if (inflated.length !== expected) throw new Error("Decompressed PNG size does not match the scanline limit");
  // pngjs checks CRCs and decodes the already bounded stream, including interlaced images.
  return PNG.sync.read(bytes);
}

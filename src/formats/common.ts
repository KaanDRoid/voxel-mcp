import { ColorMatcher, medianCut, packRGBA, unpackRGBA, type RGB } from "../color.js";
import { defaultPalette, MAX_FILE_VOXELS, type VoxModelData } from "../vox.js";

export const MAX_DIM = 256;

export function checkDims(x: number, y: number, z: number, what: string): void {
  for (const n of [x, y, z]) if (!Number.isInteger(n) || n < 1 || n > MAX_DIM) throw new Error(`${what}: dimensions must be 1..${MAX_DIM} per axis`);
}

/** Palette color of a voxel index, with the default palette used for models that have none. */
export function modelColors(model: VoxModelData): (index: number) => { r: number; g: number; b: number; a: number } {
  const palette = model.palette ?? defaultPalette();
  return index => unpackRGBA(palette[index] ?? 0);
}

export interface IndexedColors {
  palette: Uint32Array;
  /** Palette index (1..255) for an opaque color. */
  indexOf(r: number, g: number, b: number): number;
  warnings: string[];
}

/** Assigns palette indices to the colors found in an imported file; more than 255 distinct colors are
 * reduced with median cut (and reported in `warnings`). */
export function indexColors(histogram: Map<number, number>, what: string): IndexedColors {
  const warnings: string[] = [];
  const unpack = (k: number) => [(k >>> 16) & 255, (k >>> 8) & 255, k & 255] as RGB;
  const palette = new Uint32Array(256);
  const colors: RGB[] = [];
  if (histogram.size <= 255) for (const key of histogram.keys()) colors.push(unpack(key));
  else {
    colors.push(...medianCut([...histogram].map(([key, weight]) => ({ rgb: unpack(key), weight })), 255));
    warnings.push(`${what}: ${histogram.size} distinct colors reduced to 255 (median-cut)`);
  }
  colors.forEach((c, i) => { palette[i + 1] = packRGBA(c[0], c[1], c[2], 255); });
  const exact = new Map<number, number>();
  colors.forEach((c, i) => exact.set((c[0] << 16) | (c[1] << 8) | c[2], i + 1));
  const matcher = colors.length ? new ColorMatcher(colors, "lab") : undefined;
  return {
    palette, warnings,
    indexOf(r, g, b) {
      const hit = exact.get((r << 16) | (g << 8) | b);
      if (hit) return hit;
      const idx = matcher!.nearest(r, g, b).index + 1;
      exact.set((r << 16) | (g << 8) | b, idx);
      return idx;
    },
  };
}

export function checkVoxelBudget(count: number, what: string): void {
  if (count > MAX_FILE_VOXELS) throw new Error(`${what}: voxel count exceeds the supported limit`);
}

import { defaultPalette } from './vox.js';
import type { VoxModelData } from './vox.js';

/** Index (1..255) of the target palette entry closest to `color` (squared RGB distance; exact matches win, ties pick the lowest index). */
export function nearestPaletteIndex(target: Uint32Array, color: number): number {
  const r = color & 255, g = (color >>> 8) & 255, b = (color >>> 16) & 255;
  let best = 1, bestDistance = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = target[i]!;
    const d = (r - (c & 255)) ** 2 + (g - ((c >>> 8) & 255)) ** 2 + (b - ((c >>> 16) & 255)) ** 2;
    if (d < bestDistance) { best = i; bestDistance = d; if (d === 0) break; }
  }
  return best;
}

/**
 * Returns a copy of `model` whose voxel indices point at the closest colors of `target`.
 * A model without a palette is read with the default palette. The result carries a copy of `target`.
 */
export function remapModelToPalette(model: VoxModelData, target: Uint32Array): VoxModelData {
  const source = model.palette ?? defaultPalette();
  const cache = new Map<number, number>();
  const voxels = model.voxels.map(v => {
    let i = cache.get(v.i);
    if (i === undefined) { i = nearestPaletteIndex(target, source[v.i]!); cache.set(v.i, i); }
    return { ...v, i };
  });
  return { sizeX: model.sizeX, sizeY: model.sizeY, sizeZ: model.sizeZ, voxels, palette: new Uint32Array(target) };
}

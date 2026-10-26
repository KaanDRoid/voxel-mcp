import { ColorMatcher, deltaE, hue, luminance, medianCut, packRGBA, rgbToLab, toHex, unpackRGBA, type ColorMetric, type RGB, type WeightedColor } from "./color.js";
import { defaultPalette, type VoxModelData } from "./vox.js";

export interface RemapReport { voxels: number; colorsChanged: number; meanDeltaE: number; maxDeltaE: number }

function effectivePalette(model: VoxModelData): Uint32Array {
  return model.palette ?? defaultPalette();
}
function usedCounts(model: VoxModelData): Map<number, number> {
  const counts = new Map<number, number>();
  for (const v of model.voxels) if (v.i >= 1 && v.i <= 255) counts.set(v.i, (counts.get(v.i) ?? 0) + 1);
  return counts;
}
const rgbOf = (c: number): RGB => { const u = unpackRGBA(c); return [u.r, u.g, u.b]; };

/** Usable target entries: indices 1..255 with some opacity (all of them if every entry is transparent is an error). */
function candidates(palette: Uint32Array): { index: number; rgb: RGB }[] {
  const out: { index: number; rgb: RGB }[] = [];
  for (let i = 1; i < 256; i++) if ((palette[i]! >>> 24) > 0) out.push({ index: i, rgb: rgbOf(palette[i]!) });
  if (!out.length) throw new Error("Target palette has no usable (non-transparent) entries");
  return out;
}

/** Replaces the model palette with `target` and moves every voxel to the closest target color. */
export function remapModelToPalette(model: VoxModelData, target: Uint32Array, opts: { metric?: ColorMetric } = {}): RemapReport {
  if (target.length !== 256) throw new Error("Palette must contain 256 entries");
  const cand = candidates(target);
  const matcher = new ColorMatcher(cand.map(c => c.rgb), opts.metric ?? "lab");
  const source = effectivePalette(model);
  const counts = usedCounts(model);
  const map = new Map<number, number>();
  let sum = 0, max = 0, voxels = 0, changed = 0;
  for (const [index, count] of counts) {
    const [r, g, b] = rgbOf(source[index]!);
    const hit = matcher.nearest(r, g, b);
    const newIndex = cand[hit.index]!.index;
    map.set(index, newIndex);
    if (newIndex !== index || target[newIndex] !== source[index]) changed++;
    sum += hit.delta * count; max = Math.max(max, hit.delta); voxels += count;
  }
  for (const v of model.voxels) { const n = map.get(v.i); if (n !== undefined) v.i = n; }
  model.palette = new Uint32Array(target);
  return { voxels, colorsChanged: changed, meanDeltaE: voxels ? sum / voxels : 0, maxDeltaE: max };
}

export interface QuantizeReport { colorsBefore: number; colorsAfter: number; meanDeltaE: number; maxDeltaE: number }

/** Builds a fresh palette (entries 1..k, opaque) from weighted colors and returns it with a matcher over it. */
function buildPalette(colors: WeightedColor[], k: number): { palette: Uint32Array; matcher: ColorMatcher } {
  const reps = medianCut(colors, k);
  const palette = new Uint32Array(256);
  reps.forEach((c, i) => { palette[i + 1] = packRGBA(c[0], c[1], c[2], 255); });
  return { palette, matcher: new ColorMatcher(reps, "lab") };
}

/** Reduces the number of distinct voxel colors to at most `maxColors` using median cut. */
export function quantizeModel(model: VoxModelData, maxColors: number): QuantizeReport {
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 255) throw new Error("maxColors must be an integer in 1..255");
  const source = effectivePalette(model), counts = usedCounts(model);
  const byColor = new Map<number, number>();
  for (const [index, count] of counts) { const key = source[index]! & 0xffffff; byColor.set(key, (byColor.get(key) ?? 0) + count); }
  const colors: WeightedColor[] = [...byColor].map(([key, weight]) => ({ rgb: [key & 255, (key >>> 8) & 255, (key >>> 16) & 255] as RGB, weight }));
  if (!colors.length) return { colorsBefore: 0, colorsAfter: 0, meanDeltaE: 0, maxDeltaE: 0 };
  const { palette, matcher } = buildPalette(colors, maxColors);
  const map = new Map<number, number>();
  let sum = 0, max = 0, voxels = 0;
  for (const [index, count] of counts) {
    const [r, g, b] = rgbOf(source[index]!);
    const hit = matcher.nearest(r, g, b);
    map.set(index, hit.index + 1);
    sum += hit.delta * count; max = Math.max(max, hit.delta); voxels += count;
  }
  for (const v of model.voxels) { const n = map.get(v.i); if (n !== undefined) v.i = n; }
  model.palette = palette;
  return { colorsBefore: byColor.size, colorsAfter: new Set(map.values()).size, meanDeltaE: sum / voxels, maxDeltaE: max };
}

/** Sorts the non-transparent palette entries among 1..255 by hue (ties by luminance) or luminance and rewrites
 * voxel indices; fully transparent entries are moved to the end. */
export function sortModelPalette(model: VoxModelData, by: "hue" | "lum", descending = false): void {
  const palette = effectivePalette(model);
  const order = Array.from({ length: 255 }, (_, i) => i + 1);
  const key = (i: number): [number, number] => {
    const [r, g, b] = rgbOf(palette[i]!);
    return by === "lum" ? [luminance(r, g, b), 0] : [hue(r, g, b), luminance(r, g, b)];
  };
  const visible = (i: number) => (palette[i]! >>> 24) > 0;
  order.sort((a, b) => {
    if (visible(a) !== visible(b)) return visible(a) ? -1 : 1; // transparent entries keep their order at the end
    if (!visible(a)) return a - b;
    const ka = key(a), kb = key(b);
    const d = ka[0] - kb[0] || ka[1] - kb[1] || a - b;
    return descending ? -d || a - b : d;
  });
  const next = new Uint32Array(256);
  next[0] = palette[0]!;
  const map = new Uint8Array(256);
  order.forEach((oldIndex, pos) => { next[pos + 1] = palette[oldIndex]!; map[oldIndex] = pos + 1; });
  for (const v of model.voxels) if (v.i >= 1 && v.i <= 255) v.i = map[v.i]!;
  model.palette = next;
}

export interface NearestHit { index: number; hex: string; rgba: number; deltaE: number }

export function findNearestColors(palette: Uint32Array, rgb: readonly number[], opts: { count?: number; metric?: ColorMetric } = {}): NearestHit[] {
  const cand = candidates(palette);
  const target = rgbToLab(rgb[0]!, rgb[1]!, rgb[2]!);
  const metric = opts.metric ?? "lab";
  const scored = cand.map(c => {
    const d = metric === "lab" ? deltaE(target, rgbToLab(...c.rgb)) : Math.hypot(rgb[0]! - c.rgb[0], rgb[1]! - c.rgb[1], rgb[2]! - c.rgb[2]);
    return { index: c.index, hex: toHex(c.rgb), rgba: palette[c.index]!, deltaE: d };
  });
  scored.sort((a, b) => a.deltaE - b.deltaE || a.index - b.index);
  return scored.slice(0, Math.max(1, Math.min(opts.count ?? 1, 255)));
}

export interface MergeReport { colors: number; meanDeltaE: number; maxDeltaE: number; quantized: boolean }

/** Gives all models one shared palette (union of used colors, quantized when more than 255). */
export function mergeModelPalettes(models: VoxModelData[]): MergeReport {
  if (models.length < 2) throw new Error("Merging palettes needs at least two models");
  const byColor = new Map<number, number>();
  const sources = models.map(effectivePalette), counts = models.map(usedCounts);
  models.forEach((_, mi) => { for (const [index, count] of counts[mi]!) { const key = sources[mi]![index]! & 0xffffff; byColor.set(key, (byColor.get(key) ?? 0) + count); } });
  const colors: WeightedColor[] = [...byColor].map(([key, weight]) => ({ rgb: [key & 255, (key >>> 8) & 255, (key >>> 16) & 255] as RGB, weight }));
  const { palette, matcher } = buildPalette(colors, 255);
  let sum = 0, max = 0, voxels = 0;
  models.forEach((model, mi) => {
    const map = new Map<number, number>();
    for (const [index, count] of counts[mi]!) {
      const [r, g, b] = rgbOf(sources[mi]![index]!);
      const hit = matcher.nearest(r, g, b);
      map.set(index, hit.index + 1);
      sum += hit.delta * count; max = Math.max(max, hit.delta); voxels += count;
    }
    for (const v of model.voxels) { const n = map.get(v.i); if (n !== undefined) v.i = n; }
    model.palette = new Uint32Array(palette);
  });
  return { colors: new Set(models.flatMap(m => m.voxels.map(v => v.i))).size, meanDeltaE: voxels ? sum / voxels : 0, maxDeltaE: max, quantized: byColor.size > 255 };
}

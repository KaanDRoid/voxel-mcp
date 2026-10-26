/** Color math shared by palette tools, importers and the GIF encoder. Palette entries are packed
 * little-endian RGBA, i.e. a uint32 laid out as 0xAABBGGRR (the byte order of a VOX RGBA chunk). */
export type RGB = [number, number, number];
export type Lab = [number, number, number];
export type ColorMetric = "lab" | "rgb";

export function packRGBA(r: number, g: number, b: number, a = 255): number {
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}
export function unpackRGBA(c: number): { r: number; g: number; b: number; a: number } {
  return { r: c & 255, g: (c >>> 8) & 255, b: (c >>> 16) & 255, a: (c >>> 24) & 255 };
}
export function toHex(rgb: readonly number[]): string {
  return "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}

const NAMED: Record<string, RGB> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], green: [0, 128, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0],
  navy: [0, 0, 128], purple: [128, 0, 128], teal: [0, 128, 128], orange: [255, 165, 0], brown: [165, 42, 42], pink: [255, 192, 203],
};

/** Parses #rgb, #rrggbb, rgb(r,g,b) and a short list of named colors. Returns undefined when unsupported. */
export function parseCssColor(input: string): RGB | undefined {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]!].map(c => parseInt(c + c, 16)) as RGB;
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m![1]!.slice(i, i + 2), 16)) as RGB;
  m = /^rgb\(\s*(\d{1,3}(?:\.\d+)?%?)\s*,\s*(\d{1,3}(?:\.\d+)?%?)\s*,\s*(\d{1,3}(?:\.\d+)?%?)\s*\)$/.exec(s);
  if (m) {
    return [m[1]!, m[2]!, m[3]!].map(v => Math.max(0, Math.min(255, Math.round(v.endsWith("%") ? parseFloat(v) * 2.55 : parseFloat(v))))) as RGB;
  }
  return NAMED[s];
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE76 color difference. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = 60 * (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

/** Nearest-color search over an explicit candidate list (results are memoized per input color). */
export class ColorMatcher {
  private readonly lab: Lab[];
  private readonly cache = new Map<number, { index: number; delta: number }>();
  constructor(readonly colors: readonly RGB[], readonly metric: ColorMetric = "lab") {
    if (!colors.length) throw new Error("Color matcher needs at least one candidate color");
    this.lab = colors.map(c => rgbToLab(c[0], c[1], c[2]));
  }
  nearest(r: number, g: number, b: number): { index: number; delta: number } {
    const key = (r << 16) | (g << 8) | b;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const target = rgbToLab(r, g, b);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.colors.length; i++) {
      const c = this.colors[i]!;
      const d = this.metric === "lab" ? deltaE(target, this.lab[i]!) : Math.hypot(r - c[0], g - c[1], b - c[2]);
      if (d < bestD) { bestD = d; best = i; }
    }
    const result = { index: best, delta: deltaE(target, this.lab[best]!) };
    if (this.cache.size < 200_000) this.cache.set(key, result);
    return result;
  }
}

export interface WeightedColor { rgb: RGB; weight: number }

/** Median-cut quantizer. Returns at most `k` colors; when there are no more than `k` distinct
 * inputs they are returned unchanged (sorted by descending weight). */
export function medianCut(input: readonly WeightedColor[], k: number): RGB[] {
  if (!Number.isInteger(k) || k < 1) throw new Error("Color count must be a positive integer");
  const merged = new Map<number, WeightedColor>();
  for (const c of input) {
    const key = (c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2];
    const prev = merged.get(key);
    if (prev) prev.weight += c.weight; else merged.set(key, { rgb: [...c.rgb] as RGB, weight: c.weight });
  }
  const unique = [...merged.values()].sort((a, b) => b.weight - a.weight);
  if (unique.length <= k) return unique.map(c => c.rgb);
  const range = (box: WeightedColor[]) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const c of box) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, c.rgb[i]!); hi[i] = Math.max(hi[i]!, c.rgb[i]!); }
    return [0, 1, 2].map(i => hi[i]! - lo[i]!);
  };
  const boxes: WeightedColor[][] = [unique];
  while (boxes.length < k) {
    let pick = -1, pickScore = -1, pickAxis = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      const r = range(box), axis = r.indexOf(Math.max(...r));
      const score = r[axis]! * Math.sqrt(box.reduce((s, c) => s + c.weight, 0));
      if (score > pickScore) { pickScore = score; pick = bi; pickAxis = axis; }
    });
    if (pick < 0) break;
    const box = boxes[pick]!.slice().sort((a, b) => a.rgb[pickAxis]! - b.rgb[pickAxis]! || a.rgb[(pickAxis + 1) % 3]! - b.rgb[(pickAxis + 1) % 3]!);
    const total = box.reduce((s, c) => s + c.weight, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { acc += box[i]!.weight; cut = i + 1; if (acc >= total / 2) break; }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(box => {
    const total = box.reduce((s, c) => s + c.weight, 0) || 1;
    return [0, 1, 2].map(i => Math.round(box.reduce((s, c) => s + c.rgb[i]! * c.weight, 0) / total)) as RGB;
  });
}

import fs from "fs";
import nodePath from "path";
import { PNG } from "pngjs";
import { ColorMatcher, parseCssColor, unpackRGBA, type RGB } from "./color.js";
import { invertAxis, parseAxis } from "./formats/axes.js";
import { indexColors } from "./formats/common.js";
import { voxelizeMesh } from "./formats/voxelize.js";
import { defaultPalette, type VoxModelData } from "./vox.js";

// ---------------------------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------------------------

export interface ObjImportOptions {
  /** Stretch the mesh to exactly this box (all three must be given). */
  sizeX?: number | undefined; sizeY?: number | undefined; sizeZ?: number | undefined;
  /** Uniformly scale the mesh so that its longest side spans this many voxels. */
  fit?: { max: number } | undefined;
  /** Mesh units per voxel edge (default 1); the inverse of the export scale. */
  scale?: number | undefined;
  /** Axes of the file as in the exporters: "XZ-Y" (default) is a Y-up file, "XYZ" a Z-up file. */
  axis?: string | undefined;
  /** "solid" (default) fills watertight meshes with the voxels whose centers are inside (thin features may
   * vanish); "surface" keeps every voxel touched by a triangle. */
  fill?: "solid" | "surface" | undefined;
  /** "auto" (default) uses textures, vertex colors and material Kd; "none" paints one palette index. */
  color?: "auto" | "none" | undefined;
  /** Palette index used when no color is available (default 200). */
  defaultIndex?: number | undefined;
  maxTriangles?: number | undefined;
  /** Reads a file referenced by the OBJ (material library or texture) relative to the OBJ file. */
  readAux?: ((relativePath: string) => Buffer | undefined) | undefined;
}
export interface ObjImportResult {
  sizeX: number; sizeY: number; sizeZ: number;
  voxels: { x: number; y: number; z: number; i: number }[];
  palette: Uint32Array | undefined;
  warnings: string[];
  triangles: number;
}

interface Material { kd?: RGB; map?: string; tex?: { w: number; h: number; data: Buffer } | undefined }

function parseMtl(text: string): Map<string, Material> {
  const out = new Map<string, Material>();
  let cur: Material | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "newmtl") { cur = {}; out.set(rest.join(" "), cur); }
    else if (key === "Kd" && cur) {
      const v = rest.slice(0, 3).map(Number);
      if (v.length === 3 && v.every(Number.isFinite)) cur.kd = v.map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)) as RGB;
    } else if (key === "map_Kd" && cur) {
      const name = rest.filter(t => !t.startsWith("-")).pop();
      if (name) cur.map = name;
    }
  }
  return out;
}

const MAX_TEXTURE_PIXELS = 16 * 1024 * 1024;

export function importOBJData(text: string, opts: ObjImportOptions): ObjImportResult {
  const maxTriangles = opts.maxTriangles ?? 500_000;
  const axis = parseAxis(opts.axis ?? "XZ-Y");
  const warnings: string[] = [];
  const useColor = (opts.color ?? "auto") === "auto";
  const solid = (opts.fill ?? "solid") === "solid";
  const defaultIndex = opts.defaultIndex ?? 200;
  const verts: number[][] = [], vcolors: (RGB | undefined)[] = [], uvs: [number, number][] = [];
  const tris: { a: number; b: number; c: number; ta: number; tb: number; tc: number; mat: number }[] = [];
  const matNames: string[] = [];
  const libs: string[] = [];
  let currentMat = -1;
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [kind, ...parts] = line.split(/\s+/);
    if (kind === "v") {
      const values = parts.slice(0, 6).map(Number);
      if (parts.length < 3 || !values.slice(0, 3).every(Number.isFinite)) throw new Error("invalid OBJ vertex");
      if (verts.length >= 3_000_000) throw new Error("OBJ vertex limit exceeded");
      verts.push(values.slice(0, 3));
      vcolors.push(values.length === 6 && values.every(Number.isFinite) ? values.slice(3).map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)) as RGB : undefined);
    } else if (kind === "vt") {
      const u = Number(parts[0]), v = Number(parts[1] ?? 0);
      uvs.push([Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0]);
    } else if (kind === "mtllib") libs.push(parts.join(" "));
    else if (kind === "usemtl") { const name = parts.join(" "); let i = matNames.indexOf(name); if (i < 0) { i = matNames.length; matNames.push(name); } currentMat = i; }
    else if (kind === "f") {
      if (parts.length < 3) throw new Error("OBJ face requires at least three vertices");
      const refs = parts.map(token => {
        const [vs, ts] = token.split("/");
        const n = Number(vs);
        if (!Number.isInteger(n) || n === 0) throw new Error("invalid OBJ face index");
        const vi = n < 0 ? verts.length + n : n - 1;
        let ti = -1;
        if (ts) { const t = Number(ts); if (Number.isInteger(t) && t !== 0) ti = t < 0 ? uvs.length + t : t - 1; }
        return [vi, ti] as [number, number];
      });
      for (let i = 1; i < refs.length - 1; i++) {
        if (tris.length >= maxTriangles) throw new Error(`OBJ exceeds the triangle limit of ${maxTriangles}`);
        tris.push({ a: refs[0]![0], b: refs[i]![0], c: refs[i + 1]![0], ta: refs[0]![1], tb: refs[i]![1], tc: refs[i + 1]![1], mat: currentMat });
      }
    }
  }
  if (tris.some(t => [t.a, t.b, t.c].some(i => i < 0 || i >= verts.length))) throw new Error("OBJ face index out of range");
  if (!verts.length || !tris.length) throw new Error("OBJ contains no geometry (vertices and faces are required)");

  // File space -> voxel space axes, then bounding box.
  const pts = verts.map(v => invertAxis(axis, v));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, p[a]!); hi[a] = Math.max(hi[a]!, p[a]!); }
  const extent = [0, 1, 2].map(a => hi[a]! - lo[a]!);
  const flat = extent.map(e => e < 1e-9);
  const stretch = [opts.sizeX, opts.sizeY, opts.sizeZ];
  let dims: number[], factor: number[];
  if (stretch.some(s => s !== undefined)) {
    if (stretch.some(s => s === undefined)) throw new Error("sizeX, sizeY and sizeZ must be given together");
    dims = stretch as number[];
    factor = dims.map((d, a) => (flat[a] ? 1 : d / extent[a]!));
  } else {
    let unit: number;
    if (opts.fit) {
      if (!Number.isInteger(opts.fit.max) || opts.fit.max < 1 || opts.fit.max > 256) throw new Error("fit.max must be an integer in 1..256 voxels");
      unit = opts.fit.max / Math.max(...extent, 1e-9);
    } else {
      const scale = opts.scale ?? 1;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("scale must be a positive number");
      unit = 1 / scale;
    }
    dims = extent.map(e => Math.max(1, Math.ceil(e * unit - 1e-6)));
    factor = [unit, unit, unit];
    if (dims.some(d => d > 256)) throw new Error(`Mesh needs ${dims.join(" x ")} voxels; the limit is 256 per axis (use fit: {max: 256} or a larger scale)`);
  }
  if (dims.some(d => !Number.isInteger(d) || d < 1 || d > 256)) throw new Error("target sizes must be integers in 1..256");
  const mapped = pts.map(p => [0, 1, 2].map(a => (flat[a] ? 0.5 : (p[a]! - lo[a]!) * factor[a]!)));

  // Watertightness: every undirected edge between welded vertices must be shared by exactly two triangles.
  const weld = new Map<string, number>();
  const ids = verts.map(v => { const k = v.map(n => Math.round(n * 1e5)).join(","); let id = weld.get(k); if (id === undefined) { id = weld.size; weld.set(k, id); } return id; });
  const edges = new Map<string, number>();
  for (const t of tris) {
    const w = [ids[t.a]!, ids[t.b]!, ids[t.c]!];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    for (let e = 0; e < 3; e++) { const a = w[e]!, b = w[(e + 1) % 3]!; const k = a < b ? `${a}|${b}` : `${b}|${a}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  }
  let badEdges = 0;
  for (const n of edges.values()) if (n !== 2) badEdges++;
  const watertight = badEdges === 0;
  if (solid && !watertight) warnings.push(`Mesh is not watertight (${badEdges} open or non-manifold edges); only the surface was voxelized`);

  // Materials and textures.
  const materials = new Map<string, Material>();
  for (const lib of libs) {
    const data = safeAux(opts.readAux, lib);
    if (!data) { warnings.push(`Material library ${lib} was not found or could not be read`); continue; }
    for (const [k, v] of parseMtl(data.toString("utf8"))) materials.set(k, v);
  }
  const textureFailures = new Set<string>();
  if (useColor) {
    for (const mat of materials.values()) {
      if (!mat.map) continue;
      const bytes = safeAux(opts.readAux, mat.map);
      if (!bytes) { textureFailures.add(mat.map); continue; }
      try {
        if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_TEXTURE_PIXELS) throw new Error("texture too large");
        const png = PNG.sync.read(bytes);
        mat.tex = { w: png.width, h: png.height, data: png.data };
      } catch { textureFailures.add(mat.map); }
    }
    for (const name of textureFailures) warnings.push(`Texture ${name} was not found or is not a readable PNG; its material color was used instead`);
  }
  const triMat = tris.map(t => (t.mat >= 0 ? materials.get(matNames[t.mat]!) : undefined));
  let anyColor = false;
  const colorAt = useColor ? (ti: number, w0: number, w1: number, w2: number): number => {
    const t = tris[ti]!, m = triMat[ti];
    let rgb: RGB | undefined;
    const ua = uvs[t.ta], ub = uvs[t.tb], uc = uvs[t.tc];
    if (m?.tex && ua && ub && uc) {
      const u = w0 * ua[0] + w1 * ub[0] + w2 * uc[0], v = w0 * ua[1] + w1 * ub[1] + w2 * uc[1];
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      const x = Math.min(m.tex.w - 1, Math.floor(fu * m.tex.w)), y = Math.min(m.tex.h - 1, Math.floor((1 - fv) * m.tex.h));
      const o = (y * m.tex.w + x) * 4;
      if (m.tex.data[o + 3]! > 0) {
        rgb = [m.tex.data[o]!, m.tex.data[o + 1]!, m.tex.data[o + 2]!];
        if (m.kd) rgb = rgb.map((c, k) => Math.round(c * m.kd![k]! / 255)) as RGB;
      }
    }
    const ca = vcolors[t.a], cb = vcolors[t.b], cc = vcolors[t.c];
    if (!rgb && ca && cb && cc) rgb = [0, 1, 2].map(k => Math.round(w0 * ca[k]! + w1 * cb[k]! + w2 * cc[k]!)) as RGB;
    if (!rgb && m?.kd) rgb = m.kd;
    if (!rgb) return -1;
    anyColor = true;
    return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  } : undefined;

  const positions = new Float64Array(tris.length * 9);
  tris.forEach((t, i) => { [t.a, t.b, t.c].forEach((vi, n) => { for (let a = 0; a < 3; a++) positions[i * 9 + n * 3 + a] = mapped[vi]![a]!; }); });
  const useParity = solid && watertight;
  const grid = voxelizeMesh({ positions, count: tris.length }, dims as [number, number, number], { mode: useParity ? "volume" : "surface", colorAt, budgetMs: 30_000 });
  if (grid.inconsistentColumns) warnings.push(`${grid.inconsistentColumns} voxel columns had inconsistent surface crossings; the mesh may self-intersect`);

  const [dx, dy, dz] = dims as [number, number, number];
  const cells: { x: number; y: number; z: number; key: number }[] = [];
  for (let k = 0; k < dz; k++) for (let j = 0; j < dy; j++) for (let i = 0; i < dx; i++) {
    const cell = i + dx * (j + dy * k);
    if (grid.filled[cell]) cells.push({ x: i, y: j, z: k, key: grid.color ? grid.color[cell]! : -1 });
  }
  if (!cells.length) warnings.push("No voxels were produced");
  if (!useColor || !anyColor) {
    return { sizeX: dx, sizeY: dy, sizeZ: dz, voxels: cells.map(c => ({ x: c.x, y: c.y, z: c.z, i: defaultIndex })), palette: undefined, warnings, triangles: tris.length };
  }
  const fallback = (204 << 16) | (204 << 8) | 204;
  const histogram = new Map<number, number>();
  for (const c of cells) { if (c.key < 0) c.key = fallback; histogram.set(c.key, (histogram.get(c.key) ?? 0) + 1); }
  const colors = indexColors(histogram, "OBJ import");
  warnings.push(...colors.warnings);
  return {
    sizeX: dx, sizeY: dy, sizeZ: dz, palette: colors.palette, warnings, triangles: tris.length,
    voxels: cells.map(c => ({ x: c.x, y: c.y, z: c.z, i: colors.indexOf((c.key >>> 16) & 255, (c.key >>> 8) & 255, c.key & 255) })),
  };
}

function safeAux(read: ObjImportOptions["readAux"], rel: string): Buffer | undefined {
  if (!read || !rel || rel.includes("\0") || nodePath.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return undefined;
  try { return read(rel); } catch { return undefined; }
}

/** Reads an OBJ file; auxiliary files must live in the same folder tree as the OBJ (or be provided by `readAux`). */
export function importOBJFile(objPath: string, opts: ObjImportOptions): ObjImportResult {
  const dir = nodePath.dirname(objPath);
  const root = fs.realpathSync(dir);
  const readAux = opts.readAux ?? ((rel: string) => {
    const target = nodePath.resolve(dir, rel);
    if (!fs.existsSync(target)) return undefined;
    const real = fs.realpathSync(target), inside = nodePath.relative(root, real);
    if (inside.startsWith("..") || nodePath.isAbsolute(inside)) return undefined;
    if (fs.statSync(real).size > 32 * 1024 * 1024) return undefined;
    return fs.readFileSync(real);
  });
  return importOBJData(fs.readFileSync(objPath, "utf8"), { ...opts, readAux });
}

/** Surface-only import into an existing model: the mesh is stretched to the model's size. Kept for the
 * simple use case; `importOBJFile` offers solid fill, colors and scaling. Returns the number of new voxels. */
export async function importOBJ(model: VoxModelData, objPath: string): Promise<number> {
  const r = importOBJFile(objPath, { sizeX: model.sizeX, sizeY: model.sizeY, sizeZ: model.sizeZ, fill: "surface", color: "none", defaultIndex: 200 });
  const occupied = new Set(model.voxels.map(v => `${v.x},${v.y},${v.z}`));
  let count = 0;
  for (const v of r.voxels) {
    const key = `${v.x},${v.y},${v.z}`;
    if (occupied.has(key)) continue;
    occupied.add(key); model.voxels.push(v); count++;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number]; // a b c d e f as in SVG
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

function parseTransform(value: string): Matrix {
  const re = /(\w+)\s*\(([^)]*)\)/g;
  if (value.replace(re, "").replace(/[\s,]/g, "") !== "") throw new Error(`unsupported SVG transform "${value.slice(0, 40)}"`);
  let m = IDENTITY;
  for (const match of value.matchAll(re)) {
    const args = match[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!args.every(Number.isFinite)) throw new Error("unsupported SVG transform: non-numeric arguments");
    const [a = 0, b, c, d, e, f] = args;
    const rad = (deg: number) => deg * Math.PI / 180;
    let t: Matrix;
    switch (match[1]) {
      case "translate": t = [1, 0, 0, 1, a, b ?? 0]; break;
      case "scale": t = [a, 0, 0, b ?? a, 0, 0]; break;
      case "rotate": {
        const cos = Math.cos(rad(a)), sin = Math.sin(rad(a));
        t = [cos, sin, -sin, cos, 0, 0];
        if (args.length === 3) t = multiply(multiply([1, 0, 0, 1, b!, c!], t), [1, 0, 0, 1, -b!, -c!]);
        break;
      }
      case "skewX": t = [1, 0, Math.tan(rad(a)), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan(rad(a)), 0, 1, 0, 0]; break;
      case "matrix":
        if (args.length !== 6) throw new Error("unsupported SVG transform: matrix needs six numbers");
        t = [a, b!, c!, d!, e!, f!]; break;
      default: throw new Error(`unsupported SVG transform ${match[1]}`);
    }
    m = multiply(m, t);
  }
  return m;
}

interface Style { fill: string; fillRule: "nonzero" | "evenodd"; stroke: string; display: boolean; visible: boolean; matrix: Matrix }
type Shape = {
  test: (x: number, y: number) => boolean;
  box: [number, number, number, number]; // local bounding box
  matrix: Matrix; inverse: Matrix; rgb: RGB;
};

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const IGNORED = new Set(["title", "desc", "metadata"]);
const SHAPES = new Set(["rect", "circle", "ellipse", "polygon", "polyline", "path"]);

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("unsupported SVG transform: singular matrix");
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Point-in-polygon for implicitly closed rings, with the nonzero or even-odd fill rule. */
function windingTest(rings: number[][][], evenOdd: boolean) {
  return (x: number, y: number): boolean => {
    let wn = 0, crossings = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!, [x2, y2] = ring[(i + 1) % ring.length]!;
        if ((y1! <= y) === (y2! <= y)) continue;
        const cross = (x2! - x1!) * (y - y1!) - (x - x1!) * (y2! - y1!);
        if (y2! > y1!) { if (cross > 0) wn++; } else if (cross < 0) wn--;
        if (x1! + (y - y1!) * (x2! - x1!) / (y2! - y1!) > x) crossings++;
      }
    }
    return evenOdd ? crossings % 2 === 1 : wn !== 0;
  };
}

function parsePath(d: string): number[][][] {
  const rings: number[][][] = [];
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, ring: number[][] = [], x = 0, y = 0, sx = 0, sy = 0, cmd = "";
  let lastCtrl: [number, number] | undefined, lastQuad: [number, number] | undefined;
  const isCmd = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
  const num = (): number => {
    const t = tokens[i++];
    if (t === undefined || isCmd(t)) throw new Error("unsupported SVG path: expected a number");
    return Number(t);
  };
  const flush = () => { if (ring.length > 1) rings.push(ring); ring = []; };
  const point = (px: number, py: number) => { x = px; y = py; ring.push([x, y]); };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (isCmd(t)) {
      cmd = t; i++;
      if (cmd === "Z" || cmd === "z") { if (ring.length) { x = sx; y = sy; flush(); ring = [[x, y]]; } lastCtrl = lastQuad = undefined; continue; }
    } else if (!cmd) throw new Error("unsupported SVG path: data must start with a command");
    else if (cmd === "Z" || cmd === "z") throw new Error("unsupported SVG path: numbers after Z");
    const rel = cmd === cmd.toLowerCase(), upper = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (upper) {
      case "M": { const nx = ox + num(), ny = oy + num(); flush(); sx = nx; sy = ny; x = nx; y = ny; ring = [[x, y]]; cmd = rel ? "l" : "L"; lastCtrl = lastQuad = undefined; break; }
      case "L": point(ox + num(), oy + num()); lastCtrl = lastQuad = undefined; break;
      case "H": point(rel ? x + num() : num(), y); lastCtrl = lastQuad = undefined; break;
      case "V": point(x, rel ? y + num() : num()); lastCtrl = lastQuad = undefined; break;
      case "C": case "S": {
        const c1: [number, number] = upper === "C" ? [ox + num(), oy + num()] : lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const c2: [number, number] = [ox + num(), oy + num()], end: [number, number] = [ox + num(), oy + num()];
        const x0 = x, y0 = y;
        for (let s = 1; s <= 24; s++) {
          const u = s / 24, v = 1 - u;
          point(v * v * v * x0 + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * end[0], v * v * v * y0 + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * end[1]);
        }
        lastCtrl = c2; lastQuad = undefined; break;
      }
      case "Q": case "T": {
        const c: [number, number] = upper === "Q" ? [ox + num(), oy + num()] : lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
        const end: [number, number] = [ox + num(), oy + num()];
        const x0 = x, y0 = y;
        for (let s = 1; s <= 16; s++) {
          const u = s / 16, v = 1 - u;
          point(v * v * x0 + 2 * v * u * c[0] + u * u * end[0], v * v * y0 + 2 * v * u * c[1] + u * u * end[1]);
        }
        lastQuad = c; lastCtrl = undefined; break;
      }
      case "A": throw new Error("unsupported SVG path command A (elliptical arcs); convert arcs to cubic curves");
      default: throw new Error(`unsupported SVG path command ${cmd}`);
    }
  }
  flush();
  return rings;
}

/** Presentation attributes merged with the declarations of the `style` attribute (which win). */
function styleOf(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...attrs };
  for (const decl of (attrs.style ?? "").split(";")) {
    const idx = decl.indexOf(":");
    if (idx > 0) out[decl.slice(0, idx).trim().toLowerCase()] = decl.slice(idx + 1).trim();
  }
  return out;
}

/** Rasterizes filled SVG shapes (rect, circle, ellipse, polygon, polyline, path with M L H V C S Q T Z,
 * groups, fill colors, fill-rule, transforms) into the XY plane of the model and extrudes them along Z.
 * The viewBox is stretched to the model size. Strokes, text, gradients, CSS, clipping, opacity, `use`,
 * and elliptical arcs raise an "unsupported SVG ..." error. */
export function importSVG(model: VoxModelData, svgPath: string, opts: { thickness?: number } = {}): { count: number; warnings: string[] } {
  const text = fs.readFileSync(svgPath, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const attributes = (source: string) => {
    const attrs: Record<string, string> = {};
    for (const m of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[m[1]!] = m[3]!;
    return attrs;
  };
  const number = (value: string | undefined, fallback = 0) => {
    if (value === undefined) return fallback;
    const n = Number(value.replace(/px$/i, ""));
    if (!Number.isFinite(n)) throw new Error("SVG requires finite numeric coordinates");
    return n;
  };
  const tags = [...text.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)];
  const rootTag = tags.find(t => !t[1] && t[2]!.toLowerCase() === "svg");
  const root = attributes(rootTag?.[3] ?? "");
  const vb = root.viewBox?.trim().split(/[\s,]+/).map(Number) ?? [0, 0, number(root.width, 100), number(root.height, 100)];
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2]! <= 0 || vb[3]! <= 0) throw new Error("invalid SVG viewport");
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  const thickness = Math.min(model.sizeZ, Math.max(1, Math.floor(opts.thickness ?? 1)));

  const shapes: Shape[] = [];
  const stack: Style[] = [{ fill: "black", fillRule: "nonzero", stroke: "none", display: true, visible: true, matrix: IDENTITY }];
  let seenRoot = false, vertexBudget = 400_000;
  const checkPaint = (s: Record<string, string>, el: string) => {
    if (s.class !== undefined) throw new Error(`unsupported SVG class attribute on <${el}> (CSS is not applied)`);
    for (const key of ["clip-path", "mask", "filter"]) if (s[key] && s[key] !== "none") throw new Error(`unsupported SVG ${key} on <${el}>`);
    for (const key of ["opacity", "fill-opacity"]) if (s[key] !== undefined && Number(s[key]) !== 1) throw new Error(`unsupported SVG opacity (${key}=${s[key]}) on <${el}>; only fully opaque shapes are supported`);
  };
  const inherit = (parent: Style, s: Record<string, string>, attrs: Record<string, string>): Style => {
    const style: Style = { ...parent };
    if (s.fill !== undefined) style.fill = s.fill;
    if (s["fill-rule"] !== undefined) style.fillRule = s["fill-rule"] === "evenodd" ? "evenodd" : "nonzero";
    if (s.stroke !== undefined) style.stroke = s.stroke;
    if (s.display !== undefined) style.display = s.display !== "none" && parent.display;
    if (s.visibility !== undefined) style.visible = s.visibility !== "hidden" && s.visibility !== "collapse";
    if (attrs.transform !== undefined) style.matrix = multiply(parent.matrix, parseTransform(attrs.transform));
    return style;
  };
  for (const tag of tags) {
    const closing = tag[1] === "/", name = tag[2]!, lower = name.toLowerCase(), selfClosing = tag[4] === "/";
    if (closing) { if (stack.length > 1 && (lower === "g" || lower === "svg")) stack.pop(); continue; }
    const attrs = attributes(tag[3] ?? "");
    const s = styleOf(attrs);
    if (lower === "svg") {
      if (seenRoot) throw new Error("unsupported SVG nested <svg> elements");
      seenRoot = true;
      checkPaint(s, "svg");
      if (!selfClosing) stack.push(inherit(stack.at(-1)!, s, {}));
      continue;
    }
    if (IGNORED.has(lower)) continue;
    if (lower !== "g" && !SHAPES.has(lower)) throw new Error(`unsupported SVG element <${name}>${lower === "line" ? " (strokes are not supported)" : ""}`);
    checkPaint(s, lower);
    const style = inherit(stack.at(-1)!, s, attrs);
    if (lower === "g") { if (!selfClosing) stack.push(style); continue; }
    if (!style.display || !style.visible) continue;
    if (style.stroke !== "none") throw new Error(`unsupported SVG stroke (${style.stroke}) on <${lower}>; shapes are filled only, remove the stroke or set stroke="none"`);
    if (style.fill === "none") continue;
    const rgb = parseCssColor(style.fill);
    if (!rgb) throw new Error(`unsupported SVG fill "${style.fill.slice(0, 30)}": use #rgb, #rrggbb, rgb() or a basic color name`);
    let test: Shape["test"], box: Shape["box"];
    if (lower === "rect") {
      const x = number(attrs.x), y = number(attrs.y), w = number(attrs.width), h = number(attrs.height);
      if (w <= 0 || h <= 0) continue;
      const rxRaw = attrs.rx !== undefined ? number(attrs.rx) : undefined, ryRaw = attrs.ry !== undefined ? number(attrs.ry) : undefined;
      const rx = Math.min(w / 2, Math.max(0, rxRaw ?? ryRaw ?? 0)), ry = Math.min(h / 2, Math.max(0, ryRaw ?? rxRaw ?? 0));
      box = [x, y, x + w, y + h];
      if (rx > 0 && ry > 0) {
        const ring: number[][] = [];
        const corner = (cx: number, cy: number, from: number) => { for (let k = 0; k <= 8; k++) { const a = from + k * Math.PI / 16; ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } };
        corner(x + w - rx, y + h - ry, 0); corner(x + rx, y + h - ry, Math.PI / 2); corner(x + rx, y + ry, Math.PI); corner(x + w - rx, y + ry, 1.5 * Math.PI);
        test = windingTest([ring], false);
      } else test = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
    } else if (lower === "circle") {
      const cx = number(attrs.cx), cy = number(attrs.cy), r = number(attrs.r);
      if (r <= 0) continue;
      box = [cx - r, cy - r, cx + r, cy + r];
      test = (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
    } else if (lower === "ellipse") {
      const cx = number(attrs.cx), cy = number(attrs.cy), rx = number(attrs.rx), ry = number(attrs.ry);
      if (rx <= 0 || ry <= 0) continue;
      box = [cx - rx, cy - ry, cx + rx, cy + ry];
      test = (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
    } else {
      let rings: number[][][];
      if (lower === "path") rings = parsePath(attrs.d ?? "");
      else {
        const nums = [...(attrs.points ?? "").matchAll(NUMBER)].map(m => Number(m[0]));
        if (nums.length % 2) throw new Error(`unsupported SVG points list on <${lower}>: odd number of coordinates`);
        const ring: number[][] = [];
        for (let k = 0; k < nums.length; k += 2) ring.push([nums[k]!, nums[k + 1]!]);
        rings = ring.length > 2 ? [ring] : [];
      }
      vertexBudget -= rings.reduce((n, r) => n + r.length, 0);
      if (vertexBudget < 0) throw new Error("SVG path complexity limit exceeded");
      if (!rings.length) continue;
      const all = rings.flat();
      box = [Math.min(...all.map(p => p[0]!)), Math.min(...all.map(p => p[1]!)), Math.max(...all.map(p => p[0]!)), Math.max(...all.map(p => p[1]!))];
      test = windingTest(rings, style.fillRule === "evenodd");
    }
    if (shapes.length >= 20000) throw new Error("SVG shape limit exceeded (20000)");
    shapes.push({ test, box, matrix: style.matrix, inverse: invert(style.matrix), rgb });
  }

  const W = model.sizeX, H = model.sizeY;
  const paint = new Int32Array(W * H).fill(-1);
  for (const shape of shapes) {
    const [bx0, by0, bx1, by1] = shape.box, m = shape.matrix;
    const corners = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]] as const;
    const xs = corners.map(([x, y]) => m[0] * x + m[2] * y + m[4]), ys = corners.map(([x, y]) => m[1] * x + m[3] * y + m[5]);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - vx) / vw * W - 0.5)), c1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - vx) / vw * W - 0.5));
    const r0 = Math.max(0, Math.floor((Math.min(...ys) - vy) / vh * H - 0.5)), r1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - vy) / vh * H - 0.5));
    const inv = shape.inverse, key = (shape.rgb[0] << 16) | (shape.rgb[1] << 8) | shape.rgb[2];
    for (let row = r0; row <= r1; row++) for (let x = c0; x <= c1; x++) {
      const px = vx + (x + 0.5) / W * vw, py = vy + (row + 0.5) / H * vh;
      if (shape.test(inv[0] * px + inv[2] * py + inv[4], inv[1] * px + inv[3] * py + inv[5])) paint[row * W + x] = key;
    }
  }
  const painted: { x: number; y: number; key: number }[] = [];
  for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) { const key = paint[row * W + x]!; if (key >= 0) painted.push({ x, y: H - 1 - row, key }); }
  const warnings: string[] = [];
  if (!painted.length) return { count: 0, warnings };
  let lookup: (key: number) => number;
  if (!model.voxels.length) {
    const histogram = new Map<number, number>();
    for (const p of painted) histogram.set(p.key, (histogram.get(p.key) ?? 0) + 1);
    const colors = indexColors(histogram, "SVG import");
    warnings.push(...colors.warnings);
    model.palette = colors.palette;
    lookup = key => colors.indexOf((key >>> 16) & 255, (key >>> 8) & 255, key & 255);
  } else {
    const palette = model.palette ?? defaultPalette();
    const cand: { index: number; rgb: RGB }[] = [];
    for (let i = 1; i < 256; i++) { const c = unpackRGBA(palette[i] ?? 0); if (c.a > 0) cand.push({ index: i, rgb: [c.r, c.g, c.b] }); }
    if (!cand.length) throw new Error("The model palette has no usable colors");
    const matcher = new ColorMatcher(cand.map(c => c.rgb), "lab");
    lookup = key => cand[matcher.nearest((key >>> 16) & 255, (key >>> 8) & 255, key & 255).index]!.index;
  }
  const occupied = new Set(model.voxels.map(v => `${v.x},${v.y},${v.z}`));
  let count = 0;
  for (const p of painted) {
    const i = lookup(p.key);
    for (let z = 0; z < thickness; z++) {
      const k = `${p.x},${p.y},${z}`;
      if (occupied.has(k)) continue;
      occupied.add(k); model.voxels.push({ x: p.x, y: p.y, z, i }); count++;
    }
  }
  return { count, warnings };
}

/** Axis conventions shared by every mesh exporter and importer.
 *
 * A spec such as "XZ-Y" lists, for each output axis, which voxel axis feeds it and with which sign:
 * out.x = vox.x, out.y = vox.z, out.z = -vox.y. "XYZ" keeps the Z-up voxel convention; "XZ-Y" is the
 * Y-up convention (a proper rotation, so handedness and face winding are preserved). */
export interface AxisSpec {
  name: string;
  perm: [number, number, number];
  sign: [number, number, number];
}

export function parseAxis(value: string): AxisSpec {
  const text = value.trim().toUpperCase();
  const tokens = text.match(/[+-]?[XYZ]/g);
  if (!tokens || tokens.join("") !== text || tokens.length !== 3) {
    throw new Error(`Invalid axis "${value}": expected three signed axes such as XYZ or XZ-Y`);
  }
  const perm: number[] = [], sign: number[] = [];
  for (const t of tokens) {
    const p = "XYZ".indexOf(t.slice(-1));
    if (perm.includes(p)) throw new Error(`Invalid axis "${value}": each axis must appear exactly once`);
    perm.push(p);
    sign.push(t.startsWith("-") ? -1 : 1);
  }
  return { name: text, perm: perm as AxisSpec["perm"], sign: sign as AxisSpec["sign"] };
}

/** Voxel space -> output space. */
export function applyAxis(spec: AxisSpec, v: readonly number[]): [number, number, number] {
  return [0, 1, 2].map(i => spec.sign[i]! * v[spec.perm[i]!]!) as [number, number, number];
}
/** Output space -> voxel space. */
export function invertAxis(spec: AxisSpec, o: readonly number[]): [number, number, number] {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[spec.perm[i]!] = spec.sign[i]! * o[i]!;
  return out as [number, number, number];
}
/** +1 for rotations, -1 when the mapping mirrors the model (winding must be flipped). */
export function axisHandedness(spec: AxisSpec): 1 | -1 {
  let inversions = 0;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (spec.perm[i]! > spec.perm[j]!) inversions++;
  const signs = spec.sign[0] * spec.sign[1] * spec.sign[2];
  return ((inversions % 2 === 0 ? 1 : -1) * signs) as 1 | -1;
}

export const AXIS_PATTERN = /^[+-]?[XYZxyz][+-]?[XYZxyz][+-]?[XYZxyz]$/;

export interface MeshTransform {
  axis: AxisSpec;
  scale: number;
  /** True when triangle winding has to be reversed to keep faces pointing outward. */
  flip: boolean;
  point(p: readonly number[]): [number, number, number];
  direction(d: readonly number[]): [number, number, number];
}

export function makeTransform(opts: { axis?: string | undefined; scale?: number | undefined; cw?: boolean | undefined }, defaultAxis: string): MeshTransform {
  const axis = parseAxis(opts.axis ?? defaultAxis);
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1e6) throw new Error("scale must be a positive finite number");
  const flip = (axisHandedness(axis) === -1) !== !!opts.cw;
  return {
    axis, scale, flip,
    point: p => applyAxis(axis, p).map(n => n * scale) as [number, number, number],
    direction: d => applyAxis(axis, d),
  };
}

/** Compact decimal formatting that hides float noise such as 0.30000000000000004. */
export function fmt(n: number): string {
  const r = Number(n.toPrecision(9));
  return String(Object.is(r, -0) ? 0 : r);
}

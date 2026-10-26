/**
 * Packed rotation (`_r`) helpers for scene transform frames.
 *
 * `_r` is one byte: bits 0-1 hold the column of the non-zero entry in row 0, bits 2-3 the column in row 1
 * (row 2 takes the remaining column), and bits 4, 5, 6 are set when the entry of row 0, 1, 2 is -1.
 * MagicaVoxel only produces the 24 proper (determinant +1) orientations; the other 24 encodable values are
 * mirrored orientations and are accepted by the codec but reported by isProperRotation() as improper.
 * Free-angle rotations do not exist in the format.
 *
 * Convention (unverified against the application): a matrix M maps a model-local offset v to M * v (column
 * vector), matching the example in the published format notes.
 */
export type Matrix3 = number[][];
export type Vec3 = [number, number, number];

export const IDENTITY_ROTATION = 4; // row0 -> column 0, row1 -> column 1, all positive

export function isValidRotation(r: number): boolean {
  if (!Number.isInteger(r) || r < 0 || r > 127) return false;
  const a = r & 3, b = (r >> 2) & 3;
  return a <= 2 && b <= 2 && a !== b;
}

function checked(r: number): void { if (!isValidRotation(r)) throw new Error('Invalid packed rotation'); }

export function decodeRotation(r: number): Matrix3 {
  checked(r);
  const cols = [r & 3, (r >> 2) & 3, 3 - (r & 3) - ((r >> 2) & 3)];
  return cols.map((col, row) => {
    const line = [0, 0, 0]; line[col] = (r >> (4 + row)) & 1 ? -1 : 1; return line;
  });
}

export function encodeRotation(m: Matrix3): number {
  if (m.length !== 3 || m.some(row => row.length !== 3)) throw new Error('Rotation matrix must be 3x3');
  const cols: number[] = []; let r = 0;
  m.forEach((row, i) => {
    const nonZero = row.map((v, c) => [v, c] as const).filter(([v]) => v !== 0);
    if (nonZero.length !== 1 || (nonZero[0]![0] !== 1 && nonZero[0]![0] !== -1)) throw new Error('Rotation matrix rows must contain exactly one +1 or -1');
    cols.push(nonZero[0]![1]);
    if (nonZero[0]![0] < 0) r |= 1 << (4 + i);
  });
  if (new Set(cols).size !== 3) throw new Error('Rotation matrix columns must be distinct');
  return r | cols[0]! | (cols[1]! << 2);
}

export function determinant(m: Matrix3): number {
  const [a, b, c] = m as [number[], number[], number[]];
  return a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
}

export function isProperRotation(r: number): boolean { return isValidRotation(r) && determinant(decodeRotation(r)) === 1; }

export function listProperRotations(): number[] {
  const out: number[] = [];
  for (let r = 0; r < 128; r++) if (isProperRotation(r)) out.push(r);
  return out;
}

/** Returns the rotation equal to applying `b` first and then `a` (matrix product a * b). */
export function composeRotations(a: number, b: number): number {
  const A = decodeRotation(a), B = decodeRotation(b);
  const out = A.map((_, i) => [0, 1, 2].map(j => A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!));
  return encodeRotation(out);
}

export function applyRotation(r: number, v: Vec3): Vec3 {
  const m = decodeRotation(r);
  return m.map(row => row[0]! * v[0] + row[1]! * v[1] + row[2]! * v[2] + 0) as Vec3;
}

/** Rotation made of quarter turns about X, then Y, then Z (right-handed, counter-clockwise for positive steps). */
export function rotationFromEulerSteps(x: number, y: number, z: number): number {
  for (const n of [x, y, z]) if (!Number.isInteger(n)) throw new Error('Rotation steps must be integers (90 degree units)');
  const quarter = (axis: 0 | 1 | 2, steps: number): number => {
    const k = ((steps % 4) + 4) % 4;
    const i = (axis + 1) % 3, j = (axis + 2) % 3;
    const m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const cos = [1, 0, -1, 0][k]!, sin = [0, 1, 0, -1][k]!;
    m[i]![i] = cos; m[i]![j] = -sin; m[j]![i] = sin; m[j]![j] = cos;
    return encodeRotation(m);
  };
  return composeRotations(quarter(2, z), composeRotations(quarter(1, y), quarter(0, x)));
}

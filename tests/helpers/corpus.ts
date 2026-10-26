import fs from 'node:fs';
import path from 'node:path';
import { defaultPalette } from '../../src/vox.js';

/**
 * Corpus helper.
 *
 * Real MagicaVoxel sample files are never copied into the repository. They are read from the install folder
 * named by MAGICAVOXEL_HOME (or the folder of MAGICAVOXEL_PATH) and tests skip when it is absent. CI uses the
 * synthetic v200 fixtures built below, which mimic the chunk layout observed in the samples.
 */

/** Sample files shipped with MagicaVoxel 0.99.7.2 (relative to the install folder's `vox` directory). */
export const SAMPLE_NAMES = [
  '3x3x3.vox', 'cars.vox', 'castle.vox', 'chr_knight.vox', 'doom.vox', 'menger.vox', 'monu1.vox', 'monu2.vox', 'monu3.vox', 'room.vox', 'teapot.vox',
  'anim/deer.vox', 'anim/Gomez.vox', 'anim/T-Rex-m.vox', 'anim/T-Rex.vox',
] as const;

/** Expected top-level chunk counts, taken from a read-only probe of the 0.99.7.2 samples. */
export interface SampleShape { models: number; nTRN: number; nGRP: number; nSHP: number; LAYR: number; MATL: number; rOBJ: number; rCAM: number; NOTE: number; IMAP: number; META: number }
const base: SampleShape = { models: 1, nTRN: 2, nGRP: 1, nSHP: 1, LAYR: 32, MATL: 256, rOBJ: 15, rCAM: 10, NOTE: 1, IMAP: 0, META: 0 };
export const SAMPLE_SHAPES: Record<string, SampleShape> = {
  '3x3x3.vox': base, 'castle.vox': base, 'chr_knight.vox': base, 'doom.vox': base, 'menger.vox': base, 'monu1.vox': base, 'monu2.vox': base, 'monu3.vox': base, 'teapot.vox': base,
  'cars.vox': { ...base, models: 2, nTRN: 3, nSHP: 2 },
  'room.vox': { ...base, IMAP: 1 },
  'anim/deer.vox': { ...base, models: 4 },
  'anim/Gomez.vox': { ...base, models: 12, LAYR: 16, META: 1 },
  'anim/T-Rex-m.vox': { ...base, models: 8, META: 1 },
  'anim/T-Rex.vox': { ...base, models: 8 },
};

export function corpusRoot(): string | undefined {
  const candidates = [process.env.MAGICAVOXEL_HOME, process.env.MAGICAVOXEL_PATH ? path.dirname(process.env.MAGICAVOXEL_PATH) : undefined];
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'vox', '3x3x3.vox'))) return c;
  return undefined;
}
export const SKIP_REASON = 'MagicaVoxel installation not available (set MAGICAVOXEL_HOME or MAGICAVOXEL_PATH)';
/** Returns the skip message for node:test options, or false when the corpus is present. */
export function corpusSkip(): string | false { return corpusRoot() ? false : SKIP_REASON; }
export function samplePath(name: string): string {
  const root = corpusRoot(); if (!root) throw new Error(SKIP_REASON);
  return path.join(root, 'vox', ...name.split('/'));
}
export function readSample(name: string): Buffer { return fs.readFileSync(samplePath(name)); }
/** Sample files that exist in the installation (all 15 for an unmodified 0.99.7.2 install). */
export function sampleFiles(): string[] {
  const root = corpusRoot(); if (!root) return [];
  return SAMPLE_NAMES.filter(n => fs.existsSync(samplePath(n)));
}

// ---------------------------------------------------------------------------------------------
// Synthetic v200 fixtures
// ---------------------------------------------------------------------------------------------
export function ints(...v: number[]): Buffer { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeInt32LE(n, i * 4)); return b; }
export function str(s: string): Buffer { const b = Buffer.from(s, 'utf8'); return Buffer.concat([ints(b.length), b]); }
export function dict(d: Record<string, string>): Buffer { return Buffer.concat([ints(Object.keys(d).length), ...Object.entries(d).flatMap(([k, v]) => [str(k), str(v)])]); }
export function chunk(id: string, content: Buffer, children: Buffer[] = []): Buffer {
  const h = Buffer.alloc(12); h.write(id, 0, 4, 'latin1'); h.writeUInt32LE(content.length, 4); h.writeUInt32LE(children.reduce((n, c) => n + c.length, 0), 8);
  return Buffer.concat([h, content, ...children]);
}
export function voxFile(children: Buffer[], version = 200): Buffer {
  return Buffer.concat([Buffer.from('VOX '), ints(version), chunk('MAIN', Buffer.alloc(0), children)]);
}
export interface SynthModel { size: [number, number, number]; voxels: [number, number, number, number][] }
export function modelPair(m: SynthModel): Buffer[] {
  const xyzi = Buffer.alloc(4 + m.voxels.length * 4); xyzi.writeUInt32LE(m.voxels.length, 0);
  m.voxels.forEach((v, i) => v.forEach((n, k) => { xyzi[4 + i * 4 + k] = n; }));
  return [chunk('SIZE', ints(...m.size)), chunk('XYZI', xyzi)];
}
export const rgbaChunk = (): Buffer => {
  const pal = defaultPalette(); const b = Buffer.alloc(1024);
  for (let i = 1; i < 256; i++) b.writeUInt32LE(pal[i]!, (i - 1) * 4);
  return chunk('RGBA', b);
};
const RENDER_OBJECTS: Record<string, string>[] = [
  { _type: '_bounce', _diffuse: '2', _specular: '5', _scatter: '5', _energy: '3' },
  { _type: '_env', _mode: '0' },
  { _type: '_inf', _i: '0.6', _k: '255 255 255', _angle: '50 50', _area: '0.07', _disk: '0' },
  { _type: '_uni', _i: '0.7', _k: '255 255 255' },
  { _type: '_ibl', _path: 'HDR_041_Path_Env.hdr', _i: '1', _rot: '0' },
  { _type: '_atm', _ray_d: '0.4', _ray_k: '45 104 255', _mie_d: '0.4', _mie_k: '255 255 255', _mie_g: '0.85', _o3_d: '0', _o3_k: '105 255 110' },
  { _type: '_fog_uni', _d: '0', _k: '255 255 255', _g: '0' },
  { _type: '_lens', _proj: '0', _fov: '45', _aperture: '0.25', _blade_n: '0', _blade_r: '0' },
  { _type: '_film', _expo: '1', _vig: '0', _aces: '1', _gam: '2.2' },
  { _type: '_bloom', _mix: '0.5', _scale: '0', _aspect: '0', _threshold: '1' },
  { _type: '_ground', _color: '80 80 80', _hor: '0.1' },
  { _type: '_bg', _color: '0 0 0' },
  { _type: '_edge', _color: '0 0 0', _width: '0.2' },
  { _type: '_grid', _color: '0 0 0', _spacing: '1', _width: '0.05', _display: '0' },
  { _type: '_setting', _ground: '1', _grid: '0', _edge: '0', _bg_c: '0', _bg_a: '0', _scale: '1 1 1', _cell: '1' },
];
export interface SynthNode { kind: 'nTRN' | 'nGRP' | 'nSHP'; id: number; attributes?: Record<string, string>; child?: number; layer?: number; frames?: Record<string, string>[]; children?: number[]; models?: { modelId: number; attributes?: Record<string, string> }[] }
export function nodeChunk(n: SynthNode): Buffer {
  const attrs = dict(n.attributes ?? {});
  if (n.kind === 'nTRN') return chunk('nTRN', Buffer.concat([ints(n.id), attrs, ints(n.child ?? 0, -1, n.layer ?? -1, (n.frames ?? [{}]).length), ...(n.frames ?? [{}]).map(dict)]));
  if (n.kind === 'nGRP') return chunk('nGRP', Buffer.concat([ints(n.id), attrs, ints((n.children ?? []).length, ...(n.children ?? []))]));
  return chunk('nSHP', Buffer.concat([ints(n.id), attrs, ints((n.models ?? []).length), ...(n.models ?? []).flatMap(m => [ints(m.modelId), dict(m.attributes ?? {})])]));
}
export interface SynthOptions {
  models: SynthModel[]; nodes: SynthNode[]; layerCount?: number; hiddenLayers?: number[]; meta?: Record<string, string>; imap?: boolean; version?: number; materials?: boolean;
}
/** Builds a v200 file with the same chunk order as MagicaVoxel 0.99.7.2: [META] models nodes LAYR RGBA [IMAP] MATL rOBJ rCAM NOTE. */
export function buildSynthetic(o: SynthOptions): Buffer {
  const children: Buffer[] = [];
  if (o.meta) children.push(chunk('META', dict(o.meta)));
  for (const m of o.models) children.push(...modelPair(m));
  for (const n of o.nodes) children.push(nodeChunk(n));
  for (let i = 0; i < (o.layerCount ?? 32); i++) children.push(chunk('LAYR', Buffer.concat([ints(i), dict({ _name: `layer ${i}`, ...(o.hiddenLayers?.includes(i) ? { _hidden: '1' } : {}) }), ints(-1)])));
  children.push(rgbaChunk());
  if (o.imap) children.push(chunk('IMAP', Buffer.from(Array.from({ length: 256 }, (_, i) => (i + 1) & 255))));
  if (o.materials !== false) for (let i = 1; i <= 256; i++) children.push(chunk('MATL', Buffer.concat([ints(i), dict(i === 256 ? { _rough: '0.1', _ior: '0.3', _ri: '1.3', _d: '0.05' } : i === 3 ? { _type: '_metal', _rough: '0.1', _ior: '0.3', _ri: '1.3', _metal: '0.7' } : { _rough: '0.1', _ior: '0.3', _ri: '1.3' })])));
  for (const r of RENDER_OBJECTS) children.push(chunk('rOBJ', dict(r)));
  for (let i = 0; i < 10; i++) children.push(chunk('rCAM', Buffer.concat([ints(i), dict({ _mode: 'pers', _focus: '0 0 0', _angle: '0 0 0', _radius: '0', _frustum: '0.414214', _fov: '45' })])));
  children.push(chunk('NOTE', Buffer.concat([ints(32), str('NOTE'), ...Array.from({ length: 31 }, () => str(''))])));
  return voxFile(children, o.version ?? 200);
}
export const cube = (n: number, i = 1): SynthModel => ({ size: [n, n, n], voxels: Array.from({ length: n ** 3 }, (_, k) => [k % n, Math.floor(k / n) % n, Math.floor(k / n / n), i] as [number, number, number, number]) });
export const singleObject = (attrs: Record<string, string> = { _t: '0 0 1' }): SynthNode[] => [
  { kind: 'nTRN', id: 0, child: 1, frames: [{}] },
  { kind: 'nGRP', id: 1, children: [2] },
  { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [attrs] },
  { kind: 'nSHP', id: 3, models: [{ modelId: 0 }] },
];
/** The two-object layout of cars.vox: scene root, group, two transforms (one rotated) and two shapes. */
export const CARS_NODES: SynthNode[] = [
  { kind: 'nTRN', id: 0, child: 1, frames: [{}] },
  { kind: 'nGRP', id: 1, children: [2, 4] },
  { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [{ _r: '17', _t: '-28 7 6' }] },
  { kind: 'nSHP', id: 3, models: [{ modelId: 0 }] },
  { kind: 'nTRN', id: 4, child: 5, layer: 1, frames: [{ _t: '16 -11 7' }] },
  { kind: 'nSHP', id: 5, models: [{ modelId: 1 }] },
];
/** Synthetic stand-ins for representative samples, keyed by the sample they imitate. */
export function syntheticFixtures(): Record<string, Buffer> {
  const frames = (n: number) => Array.from({ length: n }, (_, i) => ({ modelId: i, attributes: { _f: String(i) } }));
  return {
    '3x3x3.vox': buildSynthetic({ models: [cube(3)], nodes: singleObject() }),
    'cars.vox': buildSynthetic({ models: [{ size: [15, 34, 13], voxels: [[0, 0, 0, 5], [14, 33, 12, 6]] }, { size: [15, 32, 14], voxels: [[1, 1, 1, 7]] }], nodes: CARS_NODES }),
    'room.vox': buildSynthetic({ models: [cube(2)], nodes: singleObject(), imap: true }),
    'anim/deer.vox': buildSynthetic({ models: [cube(2), cube(2, 2), cube(2, 3), cube(2, 4)], nodes: [
      { kind: 'nTRN', id: 0, child: 1, frames: [{}] }, { kind: 'nGRP', id: 1, children: [2] },
      { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [{ _t: '0 0 1' }] }, { kind: 'nSHP', id: 3, attributes: { _loop: '1' }, models: frames(4) },
    ] }),
    'anim/Gomez.vox': buildSynthetic({ models: [cube(2), cube(2, 2), cube(2, 3)], layerCount: 16, meta: { _anim_range: '0 30' }, nodes: [
      { kind: 'nTRN', id: 0, child: 1, frames: [{}] }, { kind: 'nGRP', id: 1, children: [2] },
      { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [{ _r: '40', _t: '0 0 1' }] }, { kind: 'nSHP', id: 3, models: [{ modelId: 2, attributes: { _f: '0' } }, { modelId: 1, attributes: { _f: '1' } }, { modelId: 0, attributes: { _f: '2' } }] },
    ] }),
  };
}

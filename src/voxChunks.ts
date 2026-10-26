import type { VoxChunk } from './vox.js';

/**
 * Typed codecs for the VOX chunks that carry render and project metadata.
 *
 * Layouts (verified against the MagicaVoxel 0.99.7.2 sample files unless noted):
 * - STRING: int32 byte length + UTF-8 bytes.
 * - DICT: int32 pair count + (STRING key, STRING value) pairs.
 * - rOBJ: a single DICT whose `_type` key names the render object (15 kinds per file).
 * - rCAM: int32 camera id + DICT.
 * - NOTE: int32 count + STRING entries (32 entries in every sample; palette color notes).
 * - IMAP: exactly 256 bytes, one palette index per byte (palette index map).
 * - META: a single DICT (animation files carry `_anim_range`).
 * - MATL: int32 material id + DICT (see MATERIAL_KEYS).
 */
export type VoxDictionary = Record<string, string>;
export interface DecodeWarnings { lenient?: boolean; warnings?: string[] }

export const RENDER_CHUNK_IDS = ['rOBJ', 'rCAM', 'NOTE', 'IMAP', 'META'] as const;
export type RenderChunkId = (typeof RENDER_CHUNK_IDS)[number];

/** Observed render object kinds in the `_type` key of rOBJ chunks. */
export const RENDER_OBJECT_TYPES = ['_bounce', '_env', '_inf', '_uni', '_ibl', '_atm', '_fog_uni', '_lens', '_film', '_bloom', '_ground', '_bg', '_edge', '_grid', '_setting'] as const;

export interface RenderObject { type: string; attributes: VoxDictionary }
export interface RenderCamera { id: number; attributes: VoxDictionary }
export interface RenderSettings {
  objects: RenderObject[];
  cameras: RenderCamera[];
  /** Palette color notes from the first NOTE chunk, when present. */
  notes?: string[];
  /** Palette index map (256 entries) from the first IMAP chunk, when present. */
  imap?: number[];
  /** Project metadata dictionary from the first META chunk, when present. */
  meta?: VoxDictionary;
}

export function emptyDictionary(): VoxDictionary { return Object.create(null) as VoxDictionary; }

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer, readonly options: DecodeWarnings = {}) {}
  int(): number {
    if (this.pos + 4 > this.buf.length) throw new Error('Truncated chunk');
    const n = this.buf.readInt32LE(this.pos); this.pos += 4; return n;
  }
  count(minBytesPerItem = 4): number {
    const n = this.int();
    if (n < 0 || n > (this.buf.length - this.pos) / minBytesPerItem) throw new Error('Invalid chunk count');
    return n;
  }
  string(): string {
    const n = this.int();
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('Truncated string');
    const bytes = this.buf.subarray(this.pos, this.pos + n); this.pos += n;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      if (!this.options.lenient) throw new Error('Invalid UTF-8 string');
      this.options.warnings?.push('Invalid UTF-8 string replaced with U+FFFD');
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
  dict(): VoxDictionary {
    const n = this.count(8); const d = emptyDictionary();
    for (let i = 0; i < n; i++) {
      const k = this.string(), v = this.string();
      if (Object.hasOwn(d, k)) {
        if (!this.options.lenient) throw new Error('Duplicate dictionary key');
        this.options.warnings?.push(`Duplicate dictionary key "${k}": last value wins`);
      }
      d[k] = v;
    }
    return d;
  }
  end(): void { if (this.pos !== this.buf.length) throw new Error('Unexpected trailing bytes in chunk'); }
}

export function readDictionary(r: Reader): VoxDictionary { return r.dict(); }
export function parseDictionary(content: Buffer, options?: DecodeWarnings): VoxDictionary {
  const r = new Reader(content, options); const d = r.dict(); r.end(); return d;
}
export function createReader(content: Buffer, options?: DecodeWarnings): Reader { return new Reader(content, options); }
export type { Reader as ChunkReader };

export class Writer {
  private parts: Buffer[] = [];
  int(n: number): this {
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw new Error('Invalid chunk integer');
    const b = Buffer.alloc(4); b.writeInt32LE(n); this.parts.push(b); return this;
  }
  string(s: string): this {
    if (typeof s !== 'string') throw new Error('Dictionary values must be strings');
    const b = Buffer.from(s, 'utf8'); this.int(b.length); this.parts.push(b); return this;
  }
  dict(d: VoxDictionary): this {
    const entries = Object.entries(d); this.int(entries.length);
    for (const [k, v] of entries) { this.string(k); this.string(v); }
    return this;
  }
  bytes(b: Buffer): this { this.parts.push(b); return this; }
  build(): Buffer { return Buffer.concat(this.parts); }
}

export function buildDictionary(d: VoxDictionary): Buffer { return new Writer().dict(d).build(); }

const raw = (id: string, content: Buffer): VoxChunk => ({ id, content, children: [] });
const noChildren = (c: VoxChunk) => { if (c.children.length) throw new Error(`${c.id} cannot have children`); };

export function parseRenderObject(c: VoxChunk, options?: DecodeWarnings): RenderObject {
  noChildren(c);
  const attributes = parseDictionary(c.content, options);
  const type = attributes._type ?? '';
  return { type, attributes };
}
/** Builds an rOBJ chunk; `_type` is written first, then the remaining keys in insertion order. */
export function buildRenderObject(o: RenderObject): VoxChunk {
  const attrs = emptyDictionary();
  const { _type: ignored, ...rest } = o.attributes; void ignored;
  if (o.type) attrs._type = o.type;
  Object.assign(attrs, rest);
  return raw('rOBJ', buildDictionary(attrs));
}
export function parseRenderCamera(c: VoxChunk, options?: DecodeWarnings): RenderCamera {
  noChildren(c);
  const r = new Reader(c.content, options); const id = r.int(); const attributes = r.dict(); r.end();
  return { id, attributes };
}
export function buildRenderCamera(cam: RenderCamera): VoxChunk { return raw('rCAM', new Writer().int(cam.id).dict(cam.attributes).build()); }
export function parseNote(c: VoxChunk, options?: DecodeWarnings): string[] {
  noChildren(c);
  const r = new Reader(c.content, options); const n = r.count(4); const notes: string[] = [];
  for (let i = 0; i < n; i++) notes.push(r.string());
  r.end(); return notes;
}
export function buildNote(notes: string[]): VoxChunk { const w = new Writer().int(notes.length); for (const s of notes) w.string(s); return raw('NOTE', w.build()); }
export function parseIndexMap(c: VoxChunk): number[] {
  noChildren(c);
  if (c.content.length !== 256) throw new Error('IMAP must contain 256 bytes');
  return Array.from(c.content);
}
export function buildIndexMap(imap: number[]): VoxChunk {
  if (imap.length !== 256 || imap.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('IMAP must contain 256 byte values');
  return raw('IMAP', Buffer.from(imap));
}
export function parseMeta(c: VoxChunk, options?: DecodeWarnings): VoxDictionary { noChildren(c); return parseDictionary(c.content, options); }
export function buildMeta(meta: VoxDictionary): VoxChunk { return raw('META', buildDictionary(meta)); }

// ---------------------------------------------------------------------------------------------
// MATL
// ---------------------------------------------------------------------------------------------

/**
 * Material dictionary keys. The first group was observed in the MagicaVoxel 0.99.7.2 samples
 * (`_type` is one of `_diffuse`, `_metal`, `_glass`, `_emit` per the format notes - unverified here).
 * The second group is listed by the published format notes but was not observed in the samples.
 */
export const MATERIAL_KEYS = {
  observed: ['_type', '_rough', '_ior', '_ri', '_d', '_g', '_emit', '_flux', '_metal'],
  documented: ['_weight', '_spec', '_att', '_plastic'],
} as const;
const NUMERIC: Record<string, keyof Material> = { _rough: 'rough', _ior: 'ior', _ri: 'ri', _d: 'd', _g: 'g', _emit: 'emit', _flux: 'flux', _metal: 'metal', _weight: 'weight', _spec: 'spec', _att: 'att', _plastic: 'plastic' };
export interface Material {
  type?: string;
  rough?: number; ior?: number; ri?: number; d?: number; g?: number; emit?: number; flux?: number; metal?: number;
  weight?: number; spec?: number; att?: number; plastic?: number;
  /** Keys that are not part of the typed schema (or hold non-numeric values) are kept verbatim. */
  extra: VoxDictionary;
}
export function parseMaterial(attributes: VoxDictionary): Material {
  const m: Material = { extra: emptyDictionary() };
  for (const [k, v] of Object.entries(attributes)) {
    if (k === '_type') m.type = v;
    else if (NUMERIC[k] && v.trim() !== '' && Number.isFinite(Number(v))) (m as unknown as Record<string, number>)[NUMERIC[k]!] = Number(v);
    else m.extra[k] = v;
  }
  return m;
}
/**
 * Rebuilds a material dictionary. When `template` is given, its key order and the exact text of
 * numerically equal values are preserved, so unchanged materials are written byte-for-byte.
 */
export function buildMaterial(m: Material, template?: VoxDictionary): VoxDictionary {
  const typed = emptyDictionary();
  if (m.type !== undefined) typed._type = m.type;
  for (const [key, field] of Object.entries(NUMERIC)) {
    const v = m[field] as number | undefined;
    if (v === undefined) continue;
    if (!Number.isFinite(v)) throw new Error(`Material ${key} must be a finite number`);
    typed[key] = template?.[key] !== undefined && Number(template[key]) === v ? template[key]! : String(v);
  }
  Object.assign(typed, m.extra);
  if (!template) return typed;
  const out = emptyDictionary();
  for (const k of Object.keys(template)) if (k in typed) out[k] = typed[k]!;
  for (const k of Object.keys(typed)) if (!(k in out)) out[k] = typed[k]!;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole-document helpers
// ---------------------------------------------------------------------------------------------

/**
 * Parses typed render chunks from the top-level chunk list. Chunks that fail to parse are skipped with a
 * warning in lenient mode (they stay in the document untouched) and are fatal otherwise.
 * Returns the settings plus the chunk each typed element came from.
 */
export function parseRenderSettings(chunks: VoxChunk[], options: DecodeWarnings = {}): { render: RenderSettings; sources: Map<object, VoxChunk> } {
  const render: RenderSettings = { objects: [], cameras: [] };
  const sources = new Map<object, VoxChunk>();
  const attempt = <T>(c: VoxChunk, parse: () => T): T | undefined => {
    try { return parse(); }
    catch (error) {
      if (!options.lenient) throw error;
      options.warnings?.push(`Skipped malformed ${c.id} chunk: ${(error as Error).message}`);
      return undefined;
    }
  };
  for (const c of chunks) {
    if (c.id === 'rOBJ') { const v = attempt(c, () => parseRenderObject(c, options)); if (v) { render.objects.push(v); sources.set(v, c); } }
    else if (c.id === 'rCAM') { const v = attempt(c, () => parseRenderCamera(c, options)); if (v) { render.cameras.push(v); sources.set(v, c); } }
    else if (c.id === 'NOTE' && !render.notes) { const v = attempt(c, () => parseNote(c, options)); if (v) { render.notes = v; sources.set(v, c); } }
    else if (c.id === 'IMAP' && !render.imap) { const v = attempt(c, () => parseIndexMap(c)); if (v) { render.imap = v; sources.set(v, c); } }
    else if (c.id === 'META' && !render.meta) { const v = attempt(c, () => parseMeta(c, options)); if (v) { render.meta = v; sources.set(v, c); } }
  }
  return { render, sources };
}

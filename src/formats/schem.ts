import { gunzipSync, gzipSync } from "node:zlib";
import { ColorMatcher, packRGBA, parseCssColor, unpackRGBA, type RGB } from "../color.js";
import { defaultPalette, type VoxModelData } from "../vox.js";
import { nbt, readNbt, writeNbt } from "./nbt.js";
import { checkDims, checkVoxelBudget } from "./common.js";

/** Sponge schematic (.schem), gzip-compressed NBT, versions 2 and 3.
 * Voxel Z becomes Minecraft Y (up) and voxel Y becomes Minecraft Z reversed (a rotation, no mirroring);
 * block index = (y * Length + z) * Width + x, stored as varints that point into the block palette. */
const WOOL = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const WOOL_RGB = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];
const CONCRETE_RGB = [0xcfd5d6, 0xe06101, 0xa9309f, 0x2389c7, 0xf1af15, 0x5ea918, 0xd5658f, 0x36393d, 0x7d7d73, 0x157788, 0x64209c, 0x2d2f8f, 0x603c20, 0x495b24, 0x8e2121, 0x080a0f];
const rgb = (n: number): RGB => [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export interface BlockColor { block: string; color: string }
export type BlockSet = "wool" | "concrete" | "both";

export function defaultBlockTable(set: BlockSet = "both"): { block: string; rgb: RGB }[] {
  const out: { block: string; rgb: RGB }[] = [];
  if (set !== "concrete") WOOL.forEach((n, i) => out.push({ block: `minecraft:${n}_wool`, rgb: rgb(WOOL_RGB[i]!) }));
  if (set !== "wool") WOOL.forEach((n, i) => out.push({ block: `minecraft:${n}_concrete`, rgb: rgb(CONCRETE_RGB[i]!) }));
  return out;
}

const BLOCK_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+(\[[a-z0-9_=,]*\])?$/;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

export interface SchemOptions {
  version?: 2 | 3 | undefined;
  dataVersion?: number | undefined;
  blockSet?: BlockSet | undefined;
  /** Replaces the built-in color-to-block table. */
  blocks?: BlockColor[] | undefined;
}

function varint(n: number, out: number[]) {
  let v = n >>> 0;
  while (v > 127) { out.push((v & 127) | 128); v >>>= 7; }
  out.push(v);
}

export function encodeSchem(model: VoxModelData, opts: SchemOptions = {}): Buffer {
  const version = opts.version ?? 3;
  if (version !== 2 && version !== 3) throw new Error("Schematic version must be 2 or 3");
  const dataVersion = opts.dataVersion ?? 3465;
  if (!Number.isInteger(dataVersion) || dataVersion < 1) throw new Error("dataVersion must be a positive integer");
  checkDims(model.sizeX, model.sizeY, model.sizeZ, "Schematic export");
  let table: { block: string; rgb: RGB }[];
  if (opts.blocks) {
    if (!opts.blocks.length || opts.blocks.length > 256) throw new Error("blocks must list 1..256 block entries");
    table = opts.blocks.map(b => {
      const c = parseCssColor(b.color);
      if (!BLOCK_ID.test(b.block)) throw new Error(`Invalid block id "${b.block}": expected namespace:name with optional [state=value]`);
      if (!c) throw new Error(`Unsupported block color "${b.color}"`);
      return { block: b.block, rgb: c };
    });
  } else table = defaultBlockTable(opts.blockSet);
  const matcher = new ColorMatcher(table.map(t => t.rgb), "lab");
  const { sizeX: sx, sizeY: sy, sizeZ: sz } = model;
  const palette = model.palette ?? defaultPalette();
  const blockOfIndex = new Map<number, string>();
  const used = [...new Set(model.voxels.filter(v => v.i >= 1).map(v => v.i))].sort((a, b) => a - b);
  for (const i of used) {
    const c = unpackRGBA(palette[i] ?? 0);
    if (c.a >= 128) blockOfIndex.set(i, table[matcher.nearest(c.r, c.g, c.b).index]!.block);
  }
  const blockIds = new Map<string, number>([["minecraft:air", 0]]);
  for (const i of used) { const b = blockOfIndex.get(i); if (b && !blockIds.has(b)) blockIds.set(b, blockIds.size); }
  const volume = sx * sy * sz;
  const cells = new Uint16Array(volume);
  for (const v of model.voxels) {
    if (v.i < 1 || v.x < 0 || v.y < 0 || v.z < 0 || v.x >= sx || v.y >= sy || v.z >= sz) continue;
    const b = blockOfIndex.get(v.i);
    if (b) cells[(v.z * sy + (sy - 1 - v.y)) * sx + v.x] = blockIds.get(b)!;
  }
  const bytes: number[] = [];
  for (const id of cells) varint(id, bytes);
  const paletteTag = Object.fromEntries([...blockIds].map(([name, id]) => [name, nbt.int(id)]));
  const dims = { Width: nbt.short(sx), Height: nbt.short(sz), Length: nbt.short(sy) };
  let doc: Buffer;
  if (version === 3) {
    doc = writeNbt("", {
      Schematic: nbt.compound({
        Version: nbt.int(3), DataVersion: nbt.int(dataVersion), ...dims, Offset: nbt.intArray([0, 0, 0]),
        Blocks: nbt.compound({ Palette: nbt.compound(paletteTag), Data: nbt.byteArray(Buffer.from(bytes)), BlockEntities: nbt.list(10, []) }),
      }),
    });
  } else {
    doc = writeNbt("Schematic", {
      Version: nbt.int(2), DataVersion: nbt.int(dataVersion), ...dims, Offset: nbt.intArray([0, 0, 0]),
      PaletteMax: nbt.int(blockIds.size), Palette: nbt.compound(paletteTag), BlockData: nbt.byteArray(Buffer.from(bytes)), BlockEntities: nbt.list(10, []),
    });
  }
  return gzipSync(doc);
}

function hashColor(name: string): RGB {
  let h = 2166136261;
  for (const ch of name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return [64 + (h & 127), 64 + ((h >>> 8) & 127), 64 + ((h >>> 16) & 127)];
}

const KNOWN: Map<string, RGB> = new Map(defaultBlockTable("both").map(b => [b.block, b.rgb]));

/** Reads Sponge schematics v1 to v3. Block colors come from the built-in wool/concrete table, the `colors`
 * option (block id without state -> CSS color), or a stable hash color (reported in `warnings`). */
export function decodeSchem(file: Buffer, opts: { colors?: Record<string, string> | undefined } = {}): { model: VoxModelData; warnings: string[] } {
  let raw: Buffer;
  try { raw = gunzipSync(file, { maxOutputLength: 64 * 1024 * 1024 }); } catch { throw new Error("Not a gzip-compressed schematic file"); }
  const root = readNbt(raw).value;
  const body = (root.Schematic && typeof root.Schematic === "object" && !Buffer.isBuffer(root.Schematic) ? root.Schematic : root) as Record<string, unknown>;
  const version = body.Version;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported schematic version ${String(version)}: only Sponge v1-v3 (.schem) are supported`);
  const blocks = (version === 3 ? body.Blocks : body) as Record<string, unknown> | undefined;
  const palette = blocks?.Palette as Record<string, number> | undefined, data = (version === 3 ? blocks?.Data : body.BlockData) as Buffer | undefined;
  const width = body.Width as number, height = body.Height as number, length = body.Length as number;
  if (!palette || !Buffer.isBuffer(data) || ![width, height, length].every(n => typeof n === "number")) throw new Error("Schematic is missing Width/Height/Length, Palette or block data");
  const sx = width & 0xffff, sz = height & 0xffff, sy = length & 0xffff;
  checkDims(sx, sy, sz, "Schematic import");
  checkVoxelBudget(sx * sy * sz, "Schematic import");
  const names = new Map<number, string>();
  for (const [name, id] of Object.entries(palette)) names.set(id, name);
  const override = new Map<string, RGB>();
  for (const [k, v] of Object.entries(opts.colors ?? {})) {
    const c = parseCssColor(v);
    if (!c) throw new Error(`Unsupported color "${v}" for block ${k}`);
    override.set(k.replace(/\[.*$/, ""), c);
  }
  const model: VoxModelData = { sizeX: sx, sizeY: sy, sizeZ: sz, voxels: [], palette: new Uint32Array(256) };
  const indexOfBlock = new Map<string, number>(), unknown: string[] = [];
  const warnings: string[] = [];
  let p = 0, cell = 0;
  const total = sx * sy * sz;
  while (cell < total) {
    let id = 0, shift = 0, b: number;
    do {
      if (p >= data.length || shift > 28) throw new Error("Schematic block data is truncated or malformed");
      b = data[p++]!; id |= (b & 127) << shift; shift += 7;
    } while (b & 128);
    const x = cell % sx, z = Math.floor(cell / sx) % sy, y = Math.floor(cell / (sx * sy));
    cell++;
    const full = names.get(id);
    if (full === undefined) throw new Error(`Schematic block data references unknown palette id ${id}`);
    const name = full.replace(/\[.*$/, "");
    if (AIR.has(name)) continue;
    let index = indexOfBlock.get(name);
    if (index === undefined) {
      if (indexOfBlock.size >= 255) throw new Error("Schematic uses more than 255 distinct block types");
      index = indexOfBlock.size + 1; indexOfBlock.set(name, index);
      let c = override.get(name) ?? KNOWN.get(name);
      if (!c) { c = hashColor(name); unknown.push(name); }
      model.palette![index] = packRGBA(c[0], c[1], c[2], 255);
    }
    model.voxels.push({ x, y: sy - 1 - z, z: y, i: index });
  }
  if (unknown.length) warnings.push(`${unknown.length} block type(s) have no known color and received a generated one: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", ..." : ""}; pass colors to override`);
  return { model, warnings };
}

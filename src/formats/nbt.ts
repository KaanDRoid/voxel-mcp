/** Minimal big-endian NBT writer and bounded reader (the format used by Minecraft structure files). */
export interface NbtValue { t: number; v: unknown }
const T = { byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 } as const;

export const nbt = {
  byte: (v: number): NbtValue => ({ t: T.byte, v }),
  short: (v: number): NbtValue => ({ t: T.short, v }),
  int: (v: number): NbtValue => ({ t: T.int, v }),
  long: (v: bigint): NbtValue => ({ t: T.long, v }),
  float: (v: number): NbtValue => ({ t: T.float, v }),
  double: (v: number): NbtValue => ({ t: T.double, v }),
  string: (v: string): NbtValue => ({ t: T.string, v }),
  byteArray: (v: Buffer): NbtValue => ({ t: T.byteArray, v }),
  intArray: (v: number[]): NbtValue => ({ t: T.intArray, v }),
  longArray: (v: bigint[]): NbtValue => ({ t: T.longArray, v }),
  list: (elementType: number, items: NbtValue[]): NbtValue => ({ t: T.list, v: { elementType, items } }),
  compound: (v: Record<string, NbtValue>): NbtValue => ({ t: T.compound, v }),
};

function str(value: string): Buffer {
  const b = Buffer.from(value, "utf8");
  if (b.length > 65535) throw new Error("NBT string is too long");
  const len = Buffer.alloc(2); len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function payload(tag: NbtValue): Buffer {
  const fixed = (n: number, write: (b: Buffer) => void) => { const b = Buffer.alloc(n); write(b); return b; };
  switch (tag.t) {
    case T.byte: return fixed(1, b => b.writeInt8(tag.v as number));
    case T.short: return fixed(2, b => b.writeInt16BE(tag.v as number));
    case T.int: return fixed(4, b => b.writeInt32BE(tag.v as number));
    case T.long: return fixed(8, b => b.writeBigInt64BE(tag.v as bigint));
    case T.float: return fixed(4, b => b.writeFloatBE(tag.v as number));
    case T.double: return fixed(8, b => b.writeDoubleBE(tag.v as number));
    case T.string: return str(tag.v as string);
    case T.byteArray: { const d = tag.v as Buffer; return Buffer.concat([fixed(4, b => b.writeInt32BE(d.length)), d]); }
    case T.intArray: { const d = tag.v as number[]; return Buffer.concat([fixed(4, b => b.writeInt32BE(d.length)), ...d.map(n => fixed(4, b => b.writeInt32BE(n)))]); }
    case T.longArray: { const d = tag.v as bigint[]; return Buffer.concat([fixed(4, b => b.writeInt32BE(d.length)), ...d.map(n => fixed(8, b => b.writeBigInt64BE(n)))]); }
    case T.list: {
      const { elementType, items } = tag.v as { elementType: number; items: NbtValue[] };
      return Buffer.concat([Buffer.from([items.length ? elementType : 0]), fixed(4, b => b.writeInt32BE(items.length)), ...items.map(payload)]);
    }
    case T.compound: {
      const parts: Buffer[] = [];
      for (const [name, child] of Object.entries(tag.v as Record<string, NbtValue>)) parts.push(Buffer.from([child.t]), str(name), payload(child));
      parts.push(Buffer.from([0]));
      return Buffer.concat(parts);
    }
    default: throw new Error(`Unsupported NBT tag type ${tag.t}`);
  }
}

/** Serializes a root compound with the given name (uncompressed). */
export function writeNbt(rootName: string, root: Record<string, NbtValue>): Buffer {
  return Buffer.concat([Buffer.from([T.compound]), str(rootName), payload(nbt.compound(root))]);
}

const MAX_DEPTH = 32;
export const NBT_LIMITS = { maxBytes: 64 * 1024 * 1024, maxNodes: 100_000, maxArrayElements: 1_000_000, maxAllocatedBytes: 64 * 1024 * 1024 } as const;

/** Parses an uncompressed NBT document into plain values: byte/short/int/float/double -> number, long -> bigint,
 * byte array -> Buffer, int array -> number[], long array -> bigint[], list -> array, compound -> object. */
export function readNbt(buf: Buffer): { name: string; value: Record<string, unknown> } {
  if (buf.length > NBT_LIMITS.maxBytes) throw new Error("NBT input size limit exceeded");
  let p = 0, nodes = 0, allocatedBytes = 0;
  const allocate = (bytes: number) => { if (!Number.isSafeInteger(bytes) || bytes < 0 || (allocatedBytes += bytes) > NBT_LIMITS.maxAllocatedBytes) throw new Error("NBT allocation budget exceeded"); };
  const need = (n: number) => { if (n < 0 || p + n > buf.length) throw new Error("NBT data is truncated or declares an invalid length"); };
  const readString = () => { need(2); const n = buf.readUInt16BE(p); p += 2; need(n); allocate(n * 2); const s = buf.toString("utf8", p, p + n); p += n; return s; };
  const length = (unit: number, max: number = NBT_LIMITS.maxArrayElements) => { need(4); const n = buf.readInt32BE(p); p += 4; if (n < 0 || n * unit > buf.length - p) throw new Error("NBT data is truncated or declares an invalid length"); if (n > max) throw new Error("NBT collection limit exceeded"); return n; };
  const read = (type: number, depth: number): unknown => {
    if (++nodes > NBT_LIMITS.maxNodes) throw new Error("NBT node budget exceeded");
    if (depth > MAX_DEPTH) throw new Error("NBT nesting is too deep");
    switch (type) {
      case T.byte: need(1); return buf.readInt8(p++);
      case T.short: need(2); p += 2; return buf.readInt16BE(p - 2);
      case T.int: need(4); p += 4; return buf.readInt32BE(p - 4);
      case T.long: need(8); p += 8; return buf.readBigInt64BE(p - 8);
      case T.float: need(4); p += 4; return buf.readFloatBE(p - 4);
      case T.double: need(8); p += 8; return buf.readDoubleBE(p - 8);
      case T.string: return readString();
      case T.byteArray: { const n = length(1, NBT_LIMITS.maxBytes); allocate(n); const out = Buffer.from(buf.subarray(p, p + n)); p += n; return out; }
      case T.intArray: { const n = length(4); allocate(n * 8); const out: number[] = []; for (let i = 0; i < n; i++) { out.push(buf.readInt32BE(p)); p += 4; } return out; }
      case T.longArray: { const n = length(8); allocate(n * 32); const out: bigint[] = []; for (let i = 0; i < n; i++) { out.push(buf.readBigInt64BE(p)); p += 8; } return out; }
      case T.list: {
        need(1); const elementType = buf[p++]!; const n = length(1);
        if (n > 0 && (elementType < 1 || elementType > 12)) throw new Error("NBT list has an invalid element type");
        if (n > NBT_LIMITS.maxNodes - nodes) throw new Error("NBT node budget exceeded");
        allocate(n * 8);
        const out: unknown[] = []; for (let i = 0; i < n; i++) out.push(read(elementType, depth + 1)); return out;
      }
      case T.compound: {
        allocate(64);
        const out: Record<string, unknown> = Object.create(null);
        for (;;) {
          need(1); const childType = buf[p++]!;
          if (childType === 0) return out;
          if (childType > 12) throw new Error("NBT contains an unknown tag type");
          const name = readString();
          out[name] = read(childType, depth + 1);
        }
      }
      default: throw new Error("NBT contains an unknown tag type");
    }
  };
  need(1);
  if (buf[p++] !== T.compound) throw new Error("NBT root must be a compound tag");
  const name = readString();
  return { name, value: read(T.compound, 0) as Record<string, unknown> };
}

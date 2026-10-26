import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packRGBA } from '../src/color.js';
import { nbt, readNbt, writeNbt } from '../src/formats/nbt.js';
import { decodeSchem, encodeSchem } from '../src/formats/schem.js';
import type { VoxModelData } from '../src/vox.js';

function model(): VoxModelData {
  const p = new Uint32Array(256);
  p[1] = packRGBA(0xb0, 0x2e, 0x26); // wool red
  p[2] = packRGBA(0xf9, 0xff, 0xfe); // wool white
  p[3] = packRGBA(255, 255, 255, 0);  // transparent: becomes air
  return { sizeX: 2, sizeY: 3, sizeZ: 4, palette: p, voxels: [{ x: 1, y: 2, z: 3, i: 1 }, { x: 0, y: 0, z: 0, i: 2 }, { x: 1, y: 1, z: 1, i: 3 }] };
}
const sorted = (m: VoxModelData) => m.voxels.map(v => `${v.x},${v.y},${v.z}`).sort();

test('NBT writer and reader agree on every tag type and reject malformed data', () => {
  const root = {
    b: nbt.byte(-3), s: nbt.short(-300), i: nbt.int(70000), l: nbt.long(2n ** 40n), f: nbt.float(1.5), d: nbt.double(2.25),
    str: nbt.string('h\u00e9llo'), ba: nbt.byteArray(Buffer.from([1, 2, 3])), ia: nbt.intArray([1, -2]), la: nbt.longArray([5n]),
    list: nbt.list(3, [nbt.int(1), nbt.int(2)]), sub: nbt.compound({ x: nbt.int(9) }),
  };
  const bytes = writeNbt('root', root);
  assert.equal(bytes[0], 10);
  const back = readNbt(bytes);
  assert.equal(back.name, 'root');
  assert.deepEqual(back.value, { b: -3, s: -300, i: 70000, l: 2n ** 40n, f: 1.5, d: 2.25, str: 'h\u00e9llo', ba: Buffer.from([1, 2, 3]), ia: [1, -2], la: [5n], list: [1, 2], sub: { x: 9 } });
  assert.throws(() => readNbt(bytes.subarray(0, bytes.length - 4)), /truncated|NBT/i);
  assert.throws(() => readNbt(Buffer.from([1, 0, 0])), /NBT/);
  assert.throws(() => readNbt(Buffer.from([10, 0, 0, 7, 0, 1, 0x61, 0x7f, 0xff, 0xff, 0xff])), /NBT|length/i);
});

test('Sponge schematic v3 has the documented structure, varint block data and Y-up axes', () => {
  const m = model();
  const file = encodeSchem(m);
  const { name, value } = readNbt(gunzipSync(file));
  assert.equal(name, '');
  const s = value.Schematic as Record<string, any>;
  assert.equal(s.Version, 3);
  assert.equal(typeof s.DataVersion, 'number');
  assert.deepEqual([s.Width, s.Height, s.Length], [2, 4, 3]);
  assert.deepEqual(s.Offset, [0, 0, 0]);
  const palette = s.Blocks.Palette as Record<string, number>;
  assert.equal(palette['minecraft:air'], 0);
  assert.ok(palette['minecraft:red_wool'] > 0);
  const data = s.Blocks.Data as Buffer;
  assert.equal(data.length, 2 * 4 * 3);
  // index = (y * Length + z) * Width + x, with Minecraft z = (voxel sizeY - 1 - voxel y)
  const at = (x: number, y: number, z: number) => data[(y * 3 + z) * 2 + x]!;
  assert.equal(at(1, 3, 0), palette['minecraft:red_wool']);
  assert.equal(at(0, 0, 2), palette['minecraft:white_wool']);
  assert.equal(at(1, 1, 1), 0); // transparent voxel becomes air
  assert.equal(Object.keys(palette).length, 3);
});

test('Sponge schematic v2 layout and custom block tables with multi-byte varints', () => {
  const m = model();
  const { name, value } = readNbt(gunzipSync(encodeSchem(m, { version: 2 })));
  assert.equal(name, 'Schematic');
  assert.equal(value.Version, 2);
  assert.equal(value.PaletteMax, 3);
  assert.ok(value.BlockData instanceof Buffer);
  const blocks = Array.from({ length: 200 }, (_, i) => ({ block: `mod:block_${i}`, color: `#${(i + 1).toString(16).padStart(2, '0')}0000` }));
  const big: VoxModelData = { sizeX: 200, sizeY: 1, sizeZ: 1, palette: new Uint32Array(256), voxels: [] };
  for (let i = 0; i < 200; i++) { big.palette![i + 1] = packRGBA(i + 1, 0, 0); big.voxels.push({ x: i, y: 0, z: 0, i: i + 1 }); }
  const out = readNbt(gunzipSync(encodeSchem(big, { blocks }))).value.Schematic as Record<string, any>;
  const data = out.Blocks.Data as Buffer;
  assert.ok(data.length > 200);
  const decoded: number[] = [];
  for (let p = 0; p < data.length;) { let v = 0, shift = 0, b: number; do { b = data[p++]!; v |= (b & 127) << shift; shift += 7; } while (b & 128); decoded.push(v); }
  assert.equal(decoded.length, 200);
  assert.equal(new Set(decoded).size, 200);
  assert.ok(decoded.some(v => v >= 128));
  assert.throws(() => encodeSchem(m, { blocks: [{ block: 'Not A Block', color: '#fff' }] }), /block/i);
  assert.throws(() => encodeSchem(m, { blocks: [] }), /block/i);
  assert.throws(() => encodeSchem(m, { version: 4 as 3 }), /version/i);
});

test('schematic import round-trips shape and block colors and reports unknown blocks', () => {
  const m = model();
  const { model: back, warnings } = decodeSchem(encodeSchem(m));
  assert.deepEqual([back.sizeX, back.sizeY, back.sizeZ], [2, 3, 4]);
  assert.deepEqual(sorted(back), ['0,0,0', '1,2,3']);
  assert.deepEqual(warnings, []);
  const v = decodeSchem(encodeSchem(m, { version: 2 }));
  assert.deepEqual(sorted(v.model), ['0,0,0', '1,2,3']);
  const unknown = gzipSync(writeNbt('Schematic', {
    Version: nbt.int(2), DataVersion: nbt.int(3465), Width: nbt.short(2), Height: nbt.short(1), Length: nbt.short(1),
    Palette: nbt.compound({ 'minecraft:air': nbt.int(0), 'minecraft:stone': nbt.int(1), 'custom:thing[a=b]': nbt.int(2) }),
    BlockData: nbt.byteArray(Buffer.from([1, 2])),
  }));
  const r = decodeSchem(unknown);
  assert.equal(r.model.voxels.length, 2);
  assert.match(r.warnings.join(' '), /custom:thing/);
  const colored = decodeSchem(unknown, { colors: { 'custom:thing': '#ff0000' } });
  assert.deepEqual(colored.warnings.filter(w => /custom:thing/.test(w)), []);
  assert.throws(() => decodeSchem(Buffer.from('not gzip')), /schem|gzip|NBT/i);
  const huge = gzipSync(writeNbt('Schematic', { Version: nbt.int(2), Width: nbt.short(1000), Height: nbt.short(1), Length: nbt.short(1), Palette: nbt.compound({}), BlockData: nbt.byteArray(Buffer.alloc(0)) }));
  assert.throws(() => decodeSchem(huge), /256/);
});

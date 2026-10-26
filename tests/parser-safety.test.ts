import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { paletteFromPng } from '../src/paletteFormats.js';
import { readNbt, writeNbt, nbt } from '../src/formats/nbt.js';
import { decodeSchem } from '../src/formats/schem.js';
import { readPngBounded } from '../src/png.js';

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(name, 4, 4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name), data])));
  return Buffer.concat([header, data, crc]);
}
function png(width: number, height: number, interlace: number, inflated: Buffer): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = interlace;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(inflated)), chunk('IEND', Buffer.alloc(0))]);
}

test('palette PNG dimensions are checked before invoking the image decoder', t => {
  const file = png(256, 1_000_000, 0, Buffer.alloc(1));
  t.mock.method(PNG.sync, 'read', () => { throw new Error('decoder reached'); });
  assert.throws(() => paletteFromPng(file), /pixel limit|256 pixels|dimensions/i);
});

test('interlaced palette PNG cannot inflate beyond the scanline budget', () => {
  const file = png(256, 1, 1, Buffer.alloc(65536));
  assert.throws(() => paletteFromPng(file), /decompressed PNG.*limit|PNG.*size.*limit/i);
});

test('bounded decoding still accepts a valid interlaced PNG', () => {
  const file = png(1, 1, 1, Buffer.from([0, 255, 80, 20, 255]));
  const decoded = readPngBounded(file);
  assert.deepEqual([decoded.width, decoded.height], [1, 1]);
  assert.deepEqual([...decoded.data], [255, 80, 20, 255]);
});

function indexedPng(palettes: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    ...palettes.map(data => chunk('PLTE', data)),
    chunk('IDAT', deflateSync(Buffer.from([0, 0]))), chunk('IEND', Buffer.alloc(0))
  ]);
}

test('bounded decoding accepts an indexed PNG with a full 256-entry palette', () => {
  const palette = Buffer.alloc(768);
  palette.set([10, 20, 30]);
  const decoded = readPngBounded(indexedPng([palette]));
  assert.deepEqual([...decoded.data], [10, 20, 30, 255]);
});

test('PNG palette chunks over 256 entries are rejected before decoding', t => {
  const file = indexedPng([Buffer.alloc(3000)]);
  assert.ok(file.length < 4096);
  t.mock.method(PNG.sync, 'read', () => { throw new Error('decoder reached'); });
  assert.throws(() => readPngBounded(file), /PNG palette/i);
});

test('duplicate PNG palette chunks are rejected even when each is small', t => {
  const file = indexedPng([Buffer.alloc(300), Buffer.alloc(300)]);
  t.mock.method(PNG.sync, 'read', () => { throw new Error('decoder reached'); });
  assert.throws(() => readPngBounded(file), /PNG palette/i);
});

test('empty and non-triplet PNG palette chunks are rejected', t => {
  t.mock.method(PNG.sync, 'read', () => { throw new Error('decoder reached'); });
  for (const size of [0, 1, 2, 4, 767]) {
    assert.throws(() => readPngBounded(indexedPng([Buffer.alloc(size)])), /PNG palette/i, `size ${size}`);
  }
});

function emptyCompoundList(count: number): Buffer {
  const header = Buffer.from([10, 0, 0, 9, 0, 1, 120, 10, 0, 0, 0, 0]);
  header.writeInt32BE(count, 8);
  return Buffer.concat([header, Buffer.alloc(count), Buffer.from([0])]);
}

test('NBT rejects an oversized compound list before materializing its elements', () => {
  const raw = emptyCompoundList(100_001);
  assert.throws(() => readNbt(raw), /NBT.*budget|NBT.*limit/i);
  assert.throws(() => decodeSchem(gzipSync(raw)), /NBT.*budget|NBT.*limit/i);
});

test('NBT dictionaries keep prototype-looking keys as data', () => {
  const fields = Object.create(null) as Record<string, ReturnType<typeof nbt.int>>;
  fields.__proto__ = nbt.int(7);
  fields['constructor'] = nbt.int(8);
  const decoded = readNbt(writeNbt('', fields)).value;
  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(decoded.__proto__, 7);
  assert.equal(decoded['constructor'], 8);
});

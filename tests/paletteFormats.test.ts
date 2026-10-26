import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { defaultPalette } from '../src/vox.js';
import { packRGBA } from '../src/color.js';
import { paletteFromAct, paletteFromPng, paletteFromVox, paletteToAct, paletteToPng, paletteToVox } from '../src/paletteFormats.js';

function sample(): Uint32Array {
  const p = new Uint32Array(256);
  for (let i = 0; i < 256; i++) p[i] = packRGBA(i, 255 - i, (i * 7) & 255, 255);
  p[0] = packRGBA(9, 8, 7, 0);
  return p;
}
const home = process.env.MAGICAVOXEL_HOME ?? (process.env.MAGICAVOXEL_PATH ? path.dirname(process.env.MAGICAVOXEL_PATH) : undefined);

test('ACT export is 768 bytes of RGB in slot order and round-trips 256 colors', () => {
  const p = sample();
  const act = paletteToAct(p);
  assert.equal(act.length, 768);
  assert.deepEqual([...act.subarray(0, 3)], [1, 254, 7]);  // slot 0 holds voxel index 1
  assert.deepEqual([...act.subarray(765, 768)], [9, 8, 7]); // slot 255 holds index 0
  const back = paletteFromAct(act);
  for (let i = 0; i < 256; i++) assert.equal(back[i]! & 0xffffff, p[i]! & 0xffffff, `entry ${i}`);
  assert.equal(back[1]! >>> 24, 255);
});

test('ACT trailer sets color count and transparency; bad lengths are rejected', () => {
  const act = Buffer.concat([paletteToAct(sample()), Buffer.from([0x01, 0x00, 0x00, 0x05])]);
  const back = paletteFromAct(act);
  assert.equal(back[6]! >>> 24, 0); // slot 5 -> index 6
  assert.equal(back[7]! >>> 24, 255);
  assert.equal(paletteToAct(sample(), { trailer: true }).length, 772);
  assert.throws(() => paletteFromAct(Buffer.alloc(100)), /ACT/);
});

test('PNG palette uses the MagicaVoxel layout: 256x1, pixel k is voxel index k+1', () => {
  const p = sample();
  const png = PNG.sync.read(paletteToPng(p));
  assert.equal(png.width, 256); assert.equal(png.height, 1);
  assert.deepEqual([...png.data.subarray(0, 4)], [1, 254, 7, 255]);
  assert.deepEqual([...png.data.subarray(1020, 1024)], [9, 8, 7, 0]);
  assert.deepEqual(paletteFromPng(paletteToPng(p)), p);
  assert.throws(() => paletteFromPng(PNG.sync.write(new PNG({ width: 4, height: 4 }))), /256/);
  const square = new PNG({ width: 16, height: 16 });
  square.data.set([5, 6, 7, 255], 0);
  assert.equal(paletteFromPng(PNG.sync.write(square))[1], packRGBA(5, 6, 7, 255));
});

test('palette VOX stores an RGBA chunk and round-trips through the decoder', () => {
  const p = sample();
  const buf = paletteToVox(p);
  assert.equal(buf.toString('latin1', 0, 4), 'VOX ');
  assert.equal(buf.indexOf('RGBA') > 0, true);
  assert.deepEqual(paletteFromVox(buf), p);
  assert.throws(() => paletteFromVox(Buffer.from('VOX nope')), /VOX/);
  const d = defaultPalette();
  const back = paletteFromVox(paletteToVox(d));
  for (let i = 1; i < 256; i++) assert.equal(back[i], d[i]);
});

test('installed MagicaVoxel palette PNGs load as 256 opaque entries', { skip: !home || !fs.existsSync(path.join(home, 'palette', 'pal0.png')) }, () => {
  const p0 = paletteFromPng(fs.readFileSync(path.join(home!, 'palette', 'pal0.png')));
  assert.equal(p0[1], packRGBA(255, 255, 255, 255));
  assert.equal(p0[2], packRGBA(255, 255, 204, 255));
  const dp = defaultPalette();
  for (let i = 1; i < 256; i++) assert.equal(p0[i], dp[i], `index ${i}`);
  for (const n of [1, 2, 3]) {
    const p = paletteFromPng(fs.readFileSync(path.join(home!, 'palette', `pal${n}.png`)));
    assert.equal(p.length, 256);
  }
});

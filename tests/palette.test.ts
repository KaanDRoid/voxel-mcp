import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { defaultPalette, type VoxModelData } from '../src/vox.js';
import { setPaletteIndex, generatePalette, savePaletteToPng, loadPaletteFromPng, blendPalettes, extractPaletteFromImage } from '../src/palette.js';

const model = (): VoxModelData => ({sizeX:8,sizeY:8,sizeZ:8,voxels:[]});
test('palette extraction ignores transparent pixels, packs ABGR, and limits image size',async()=> {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'palette-'));
 try {
  const file=path.join(dir,'colors.png'); const png=new PNG({width:2,height:1});
  png.data.set([255,0,0,0,0,0,255,255]); fs.writeFileSync(file,PNG.sync.write(png));
  const pal=await extractPaletteFromImage(file,1);
  assert.equal(pal[0],0); assert.equal(pal[1],0xfff80808);
  const buf=fs.readFileSync(file);buf.writeUInt32BE(100000,16);buf.writeUInt32BE(100000,20);fs.writeFileSync(file,buf);
  await assert.rejects(()=>extractPaletteFromImage(file),/pixel|limit/i);
  assert.throws(()=>loadPaletteFromPng(model(),file),/pixel|limit/i);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('palette operations use RGBA little-endian packing and retain defaults', async () => {
  const m = model(); const defaults = defaultPalette();
  setPaletteIndex(m, 3, 0x80402010);
  assert.equal(m.palette![4], defaults[4]);
  assert.equal(generatePalette('neon')[1], 0xff110d07);
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'palette-'));
  try {
    const file = path.join(dir,'palette.png');
    savePaletteToPng(m,file);
    const png = PNG.sync.read(fs.readFileSync(file));
    assert.deepEqual([...png.data.subarray(12,16)], [16,32,64,128]);
    const n = model(); loadPaletteFromPng(n,file);
    assert.deepEqual(n.palette,m.palette);
    const pal = await extractPaletteFromImage(file,1);
    assert.equal(pal.length,256);
    const a = new Uint32Array(256); a[1]=0xff0000ff;
    const b = new Uint32Array(256); b[1]=0xffff0000;
    assert.equal(blendPalettes(a,b,.25)[1],0xff4000bf);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

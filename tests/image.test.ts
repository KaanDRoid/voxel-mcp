import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { VoxModelData } from '../src/vox.js';
import { defaultPalette } from '../src/vox.js';
import * as image from '../src/image.js';
import { imageToVoxel } from '../src/generators.js';
const model = (): VoxModelData => ({sizeX:2,sizeY:1,sizeZ:2,voxels:[]});
async function fixture(pixels:number[][], fn:(file:string)=>Promise<void>) {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'image-'));
  const file=path.join(dir,'input.png'); const png=new PNG({width:pixels.length,height:1});
  png.data.set(pixels.flat()); fs.writeFileSync(file,PNG.sync.write(png));
  try {await fn(file);} finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('every single-image conversion skips transparent pixels and crops rather than stacks boundary cells',async()=> {
 await fixture([[255,0,0,255],[255,255,255,0],[0,255,0,255]],async file=> {
  const calls=[
   (m:VoxModelData)=>image.edgeDetectToVoxel(m,file,{threshold:0}),
   (m:VoxModelData)=>image.depthMapToVoxel(m,file,{}),
   (m:VoxModelData)=>image.silhouetteTo3D(m,file,{thickness:1}),
   (m:VoxModelData)=>imageToVoxel(m,file,{mode:'extrude',maxZ:1,threshold:0,downscale:1}),
   (m:VoxModelData)=>imageToVoxel(m,file,{mode:'heightmap',maxZ:1,threshold:0,downscale:1})
  ];
  for(const call of calls) {const m=model();await call(m);assert.equal(m.voxels.length,1);assert.equal(m.voxels[0]!.x,0);}
  const m=model();await imageToVoxel(m,file,{mode:'extrude',maxZ:1,threshold:0,downscale:1});
  assert.equal((m.palette??defaultPalette())[m.voxels[0]!.i],0xff0000ff);
 });
});

test('image entry points reject empty sampled dimensions and oversized files/pixel counts',async()=> {
 await fixture([[255,255,255,255]],async file=> {
  const calls=[
   ()=>image.imageToVoxelColorized(model(),file,{downscale:2}),
   ()=>image.edgeDetectToVoxel(model(),file,{downscale:2}),
   ()=>image.depthMapToVoxel(model(),file,{downscale:2}),
   ()=>image.silhouetteTo3D(model(),file,{downscale:2,thickness:1}),
   ()=>image.multiViewToVoxel(model(),{frontPath:file,downscale:2}),
   ()=>imageToVoxel(model(),file,{mode:'extrude',maxZ:1,threshold:1,downscale:2})
  ];
  for(const call of calls) await assert.rejects(call,/sample|dimension/i);
  const buf=fs.readFileSync(file); buf.writeUInt32BE(100000,16); buf.writeUInt32BE(100000,20); fs.writeFileSync(file,buf);
  await assert.rejects(()=>image.imageToVoxelColorized(model(),file,{}),/pixel|limit/i);
  fs.truncateSync(file,32*1024*1024+1);
  await assert.rejects(()=>image.imageToVoxelColorized(model(),file,{}),/file|limit/i);
 });
});

test('silhouettes use brightness for opaque input and alpha for transparent input', async()=> {
  for (const transparent of [false,true]) await fixture(transparent ? [[0,0,0,255],[255,255,255,0]] : [[255,255,255,255],[0,0,0,255]], async file=> {
    const m=model(); await image.multiViewToVoxel(m,{frontPath:file});
    assert.equal(m.voxels.length,2); assert.ok(m.voxels.every(v=>v.x===0));
    const n=model(); await image.silhouetteTo3D(n,file,{thickness:1});
    assert.equal(n.voxels.length,1); assert.equal(n.voxels[0]!.x,0);
  });
});

test('colorized pixels match actual palette colors, skip transparency, crop oversized input', async()=> {
  await fixture([[255,0,0,255],[0,0,255,0],[0,255,0,255]],async file=> {
    const m=model(); await image.imageToVoxelColorized(m,file,{threshold:0});
    assert.equal(m.voxels.length,1);
    const color=(m.palette ?? defaultPalette())[m.voxels[0]!.i]!;
    assert.equal(color & 255,255); assert.equal((color>>>16)&255,0);
  });
});

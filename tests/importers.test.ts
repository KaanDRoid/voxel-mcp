import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importOBJ, importSVG } from '../src/importers.js';
import type { VoxModelData } from '../src/vox.js';
async function fixture(ext:string,text:string,fn:(file:string)=>Promise<void>|void){const dir=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'voxel-import-'));try{const file=path.join(dir,`test.${ext}`);fs.writeFileSync(file,text);await fn(file);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('SVG malformed geometry is rejected before mutating the model',async()=>fixture('svg',"<svg><rect width='10' height='10'/><circle r='invalid'/></svg>",file=>{
 const m:VoxModelData={sizeX:10,sizeY:10,sizeZ:1,voxels:[]};assert.throws(()=>importSVG(m,file,{}),/numeric/);assert.equal(m.voxels.length,0);
}));

test('SVG unsupported geometry/styles/transforms fail explicitly rather than importing incorrect silhouettes',async()=>{
 for(const body of ["<path d='M0 0L10 10'/>","<g transform='translate(2,3)'><rect width='5' height='5'/></g>","<rect width='5' height='5' style='fill:none'/>"]){
 await fixture('svg',`<svg viewBox='0 0 10 10'>${body}</svg>`,file=>{const m:VoxModelData={sizeX:10,sizeY:10,sizeZ:1,voxels:[]};assert.throws(()=>importSVG(m,file,{}),/unsupported SVG/);assert.equal(m.voxels.length,0);});}
});

test('SVG rectangle attribute order/defaults and single quotes preserve viewport and clip outside geometry',async()=>fixture('svg',"<svg viewBox='0 0 10 10'><rect height='5' width='5'/><rect width='3' height='3' x='30' y='30'/></svg>",file=>{
 const m:VoxModelData={sizeX:10,sizeY:10,sizeZ:2,voxels:[]};importSVG(m,file,{thickness:1.9});assert.equal(m.voxels.length,25);
 assert.ok(m.voxels.every(v=>v.x>=0&&v.x<5&&v.y>=5&&v.y<10&&v.z===0));
 importSVG(m,file,{thickness:1});assert.equal(m.voxels.length,25);
}));
test('SVG circles remain clipped and geometrically correct in a nonsquare viewport',async()=>fixture('svg',"<svg viewBox='0 0 20 10'><circle r='4' cy='0' cx='0'/></svg>",file=>{
 const m:VoxModelData={sizeX:20,sizeY:20,sizeZ:1,voxels:[]};importSVG(m,file,{});assert.ok(m.voxels.length>0);
 assert.ok(m.voxels.every(v=>v.x>=0&&v.x<20&&v.y>=0&&v.y<20&&v.z===0));
 assert.ok(m.voxels.some(v=>v.y===12));assert.ok(!m.voxels.some(v=>v.x>=4));
}));

test('OBJ resolves negative face indices, triangulates quads, converts Y-up and deduplicates',async()=>fixture('obj','v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4/-1 -3/-1 -2/-1 -1/-1 # quad',async file=>{
 const m:VoxModelData={sizeX:5,sizeY:1,sizeZ:5,voxels:[]};const count=await importOBJ(m,file);
 assert.equal(count,25);assert.equal(m.voxels.length,25);assert.ok(m.voxels.some(v=>v.x===0&&v.z===4));assert.ok(m.voxels.every(v=>v.y===0));
 assert.equal(await importOBJ(m,file),0);
}));

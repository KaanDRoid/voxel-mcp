import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decodeXRAW } from '../src/formats/xraw.js';
import { decodeQB } from '../src/formats/qb.js';
import { decodeSlab6, encodeSlab6 } from '../src/formats/slab6.js';
import { exportOBJ, exportPLY } from '../src/export.js';
import type { VoxModelData } from '../src/vox.js';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/native-0.99.7.2/${name}`, import.meta.url));
function model(): VoxModelData {
  const palette = new Uint32Array(256); palette[1]=0xff1450ff;palette[2]=0xffff5014;palette[3]=0xff50ff14;palette[4]=0xffb45a28;
  return {sizeX:3,sizeY:4,sizeZ:5,palette,voxels:[{x:0,y:0,z:0,i:1},{x:2,y:0,z:1,i:2},{x:0,y:3,z:4,i:3},{x:1,y:1,z:2,i:4}]};
}
const colored = (m: VoxModelData) => m.voxels.map(v=>[v.x,v.y,v.z,m.palette![v.i]]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const positions = (m: VoxModelData) => m.voxels.map(v=>[v.x,v.y,v.z]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

for (const [file, reader] of [['native.xraw', decodeXRAW], ['native.qb', decodeQB]] as const) test(`${file}: actual MagicaVoxel export decodes to the independently specified asymmetric colored grid`,()=>{
  assert.deepEqual(colored(reader(fixture(file)).model),colored(model()));
});

test('native Slab6 export preserves XYZ after its actual Y/Z conversion',()=>{
  assert.deepEqual(positions(decodeSlab6(fixture('native-slab.vox')).model),positions(model()));
});
test('Slab6 encoder matches native exported bytes including palette quantization',()=>{
  assert.deepEqual(encodeSlab6(model()),fixture('native-slab.vox'));
});

type V = number[];
function surfaces(vertices: V[], faces: {ids:number[];color:number}[]) {
  const result=new Map<string,number>();
  for(const face of faces){
    const p=face.ids.map(i=>vertices[i]!);let area=0;let normal:V=[];
    for(let i=1;i<p.length-1;i++){
      const a=p[i]!.map((n,j)=>n-p[0]![j]!);const b=p[i+1]!.map((n,j)=>n-p[0]![j]!);
      normal=[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];area+=Math.hypot(...normal)/2;
    }
    const axis=normal.findIndex(n=>Math.abs(n)>1e-8);assert.ok(axis>=0);
    const min=[0,1,2].map(i=>Math.min(...p.map(v=>v[i]!)).toFixed(6));const max=[0,1,2].map(i=>Math.max(...p.map(v=>v[i]!)).toFixed(6));
    const key=JSON.stringify([axis,Math.sign(normal[axis]!),min,max,face.color]);result.set(key,(result.get(key)??0)+area);
  }
  return [...result].map(([k,a])=>[k,Number(a.toFixed(6))]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
}
function obj(text:string){
  const vertices:V[]=[],uv:number[]=[],faces:{ids:number[];color:number}[]=[];
  for(const line of text.split(/\r?\n/)){
    const s=line.trim().split(/\s+/);
    if(s[0]==='v')vertices.push(s.slice(1,4).map(Number));
    if(s[0]==='vt')uv.push(Number(s[1]));
    if(s[0]==='f'){
      const parts=s.slice(1).map(v=>v.split('/').map(Number));
      faces.push({ids:parts.map(v=>v[0]!-1),color:Math.round(uv[parts[0]![1]!-1]!*256-0.5)+1});
    }
  }
  return surfaces(vertices,faces);
}
function ply(text:string){
  const lines=text.trim().split(/\r?\n/);const count=Number(/element vertex (\d+)/.exec(text)![1]);const faceCount=Number(/element face (\d+)/.exec(text)![1]);
  const header=lines.indexOf('end_header')+1;const entries=lines.slice(header,header+count).map(l=>l.trim().split(/\s+/).map(Number));
  const colors=model().palette!;
  const faces=lines.slice(header+count,header+count+faceCount).map(l=>{
    const ids=l.trim().split(/\s+/).slice(1).map(Number);const v=entries[ids[0]!]!;const rgba=(v[3]!|(v[4]!<<8)|(v[5]!<<16)|0xff000000)>>>0;
    return {ids,color:Array.from(colors).indexOf(rgba)};
  });
  return surfaces(entries.map(v=>v.slice(0,3)),faces);
}

test('Magica OBJ profile matches native colored surfaces, centered XY pivot and winding',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-obj-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'out.obj');exportOBJ(model(),file,{profile:'magica'});
  assert.deepEqual(obj(fs.readFileSync(file,'utf8')),obj(fixture('native.obj').toString('utf8')));
});
test('Magica PLY profile matches native colored mesh surfaces, scale, pivot and Z-up winding',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-ply-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'out.ply');exportPLY(model(),file,{profile:'magica'});
  assert.deepEqual(ply(fs.readFileSync(file,'utf8')),ply(fixture('native.ply').toString('utf8')));
});

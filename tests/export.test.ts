import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { exportOBJ, exportPLY, exportSlices } from '../src/export.js';
import { exportSTL, exportGLTF, exportMinecraftSchematic } from '../src/export_extra.js';
import { simplifyModel } from '../src/smart.js';
import type { VoxModelData } from '../src/vox.js';
const palette=new Uint32Array(256);palette[1]=0xff0000ff;palette[2]=0xff00ff00;
const model:VoxModelData={sizeX:2,sizeY:1,sizeZ:1,palette,voxels:[{x:0,y:0,z:0,i:1},{x:1,y:0,z:0,i:2}]};
function withDir(fn:(dir:string)=>void){const dir=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'voxel-export-'));try{fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function cross(a:number[],b:number[],c:number[]){const u=b.map((v,i)=>v-a[i]!),v=c.map((n,i)=>n-a[i]!);return [u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];}
test('empty and invalid voxel entries do not produce STL or point-cloud geometry',()=>withDir(dir=>{
 const empty:VoxModelData={sizeX:1,sizeY:1,sizeZ:1,voxels:[{x:0,y:0,z:0,i:0},{x:-1,y:0,z:0,i:1}]};
 const stl=path.join(dir,'empty.stl');exportSTL(empty,stl);assert.equal((fs.readFileSync(stl,'utf8').match(/facet normal/g)??[]).length,0);
 const ply=path.join(dir,'empty.ply');exportPLY(empty,ply);assert.match(fs.readFileSync(ply,'utf8'),/element vertex 0/);
 const gltf=path.join(dir,'empty.gltf');exportGLTF(empty,gltf);const decoded=JSON.parse(fs.readFileSync(gltf,'utf8'));assert.equal(decoded.meshes,undefined);
}));

test('slice export refuses to write through symlinked child entries',(t)=>withDir(dir=>{
 const outside=path.join(dir,'outside.txt');fs.writeFileSync(outside,'keep');const out=path.join(dir,'out');fs.mkdirSync(out);
 try{fs.symlinkSync(outside,path.join(out,'slice_0000.png'));}catch{t.skip('symlink creation not permitted');return;}
 assert.throws(()=>exportSlices(model,out),/symlink/);assert.equal(fs.readFileSync(outside,'utf8'),'keep');
}));

test('simplification retains edge voxels inside the resized bounds for export',()=>{
 const m:VoxModelData={sizeX:3,sizeY:5,sizeZ:3,palette,voxels:[{x:2,y:4,z:2,i:1}]};simplifyModel(m,2);
 assert.deepEqual([m.sizeX,m.sizeY,m.sizeZ],[2,3,2]);assert.deepEqual(m.voxels,[{x:1,y:2,z:1,i:1}]);
 assert.throws(()=>simplifyModel(m,NaN),/factor/);
});

test('Minecraft schematic is gzip big-endian NBT with wool blocks, correct axes and air',()=>withDir(dir=>{
 const file=path.join(dir,'test.schematic');exportMinecraftSchematic({...model,sizeY:3,sizeZ:4,voxels:[{x:1,y:2,z:3,i:1}]},file);
 const b=gunzipSync(fs.readFileSync(file));let p=0;
 const str=()=>{const n=b.readUInt16BE(p);p+=2;const s=b.toString('utf8',p,p+n);p+=n;return s;};
 assert.equal(b[p++],10);assert.equal(str(),'Schematic');const tags:Record<string,unknown>={};
 while(b[p]!==0){const type=b[p++]!,name=str();if(type===2){tags[name]=b.readInt16BE(p);p+=2;}else if(type===8){tags[name]=str();}else if(type===7){const n=b.readInt32BE(p);p+=4;tags[name]=b.subarray(p,p+n);p+=n;}else if(type===9){assert.equal(b[p++],10);assert.equal(b.readInt32BE(p),0);p+=4;tags[name]=[];}else assert.fail(`Unexpected NBT type ${type}`);}
 assert.equal(p+1,b.length);assert.equal(tags.Width,2);assert.equal(tags.Height,4);assert.equal(tags.Length,3);assert.equal(tags.Materials,'Alpha');
 const blocks=tags.Blocks as Buffer,data=tags.Data as Buffer;assert.equal(blocks.length,24);assert.equal(data.length,24);assert.equal(blocks[23],35);assert.equal(data[23],14);assert.equal(blocks.filter(v=>v===0).length,23);
 assert.deepEqual(tags.Entities,[]);assert.deepEqual(tags.TileEntities,[]);
}));

test('slices run in ESM and decode palette RGBA, PLY uses default palette not index grayscale',()=>withDir(dir=>{
 exportSlices(model,dir);const png=PNG.sync.read(fs.readFileSync(path.join(dir,'slice_0000.png')));
 assert.deepEqual([...png.data],[255,0,0,255,0,255,0,255]);
 const ply=path.join(dir,'test.ply');exportPLY({sizeX:1,sizeY:1,sizeZ:1,voxels:[{x:0,y:0,z:0,i:1}]},ply);
 const line=fs.readFileSync(ply,'utf8').trim().split('\n').at(-1)!;
 assert.notEqual(line,'0 0 0 1 1 1');
}));

test('OBJ and STL retain exposed faces with outward winding (OBJ Y-up, STL Z-up), OBJ colors stay self-contained',()=>withDir(dir=>{
 const file=path.join(dir,'test.obj');exportOBJ(model,file);const lines=fs.readFileSync(file,'utf8').split('\n');
 const vertices=lines.filter(l=>l.startsWith('v ')).map(l=>l.split(/\s+/).slice(1).map(Number));
 assert.ok(vertices.every(v=>v.length===6));assert.ok(vertices.some(v=>v[3]===1&&v[4]===0));assert.ok(vertices.some(v=>v[3]===0&&v[4]===1));
 assert.ok(!lines.some(l=>l.startsWith('mtllib')));
 const faces=lines.filter(l=>l.startsWith('f ')).map(l=>l.split(/\s+/).slice(1).map(i=>vertices[Number(i)-1]!));assert.equal(faces.length,10);
 for(const f of faces){const normal=cross(f[0]!,f[1]!,f[2]!),center=[0,1,2].map(j=>f.reduce((s,v)=>s+v[j]!,0)/4-[1,.5,-.5][j]!);assert.ok(normal.reduce((s,v,j)=>s+v*center[j]!,0)>0);}
 const stl=path.join(dir,'test.stl');exportSTL(model,stl);const text=fs.readFileSync(stl,'utf8');
 const facets=[...text.matchAll(/facet normal ([^\n]+)\n\s+outer loop\n\s+vertex ([^\n]+)\n\s+vertex ([^\n]+)\n\s+vertex ([^\n]+)/g)];assert.equal(facets.length,20);
 for(const f of facets){const nums=(s:string)=>s.trim().split(/\s+/).map(Number),n=nums(f[1]!),a=nums(f[2]!),b=nums(f[3]!),c=nums(f[4]!);const geometric=cross(a,b,c);assert.deepEqual(geometric.map(v=>v||0),n);}
}));

test('glTF embeds valid aligned buffers, exposed geometry, outward normals and palette materials',()=>withDir(dir=>{
 const file=path.join(dir,'test.gltf');exportGLTF(model,file);const gltf=JSON.parse(fs.readFileSync(file,'utf8'));
 const buffers:Buffer[]=gltf.buffers.map((b:{uri:string;byteLength:number})=>{const decoded=Buffer.from(b.uri.split(',')[1]!,'base64');assert.equal(decoded.length,b.byteLength);return decoded;});
 for(const view of gltf.bufferViews){assert.equal((view.byteOffset??0)%4,0);assert.ok((view.byteOffset??0)+view.byteLength<=buffers[view.buffer]!.length);}
 const read=(index:number)=>{const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView],buf=buffers[v.buffer]!,offset=(v.byteOffset??0)+(a.byteOffset??0),n=a.type==='VEC3'?3:1;
 return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,j)=>a.componentType===5126?buf.readFloatLE(offset+(i*n+j)*4):buf.readUInt32LE(offset+(i*n+j)*4)));};
 let triangles=0;
 const factors:number[][]=[];
 for(const p of gltf.meshes[0].primitives){const positions=read(p.attributes.POSITION),indices=read(p.indices).flat(),normals=read(p.attributes.NORMAL);triangles+=indices.length/3;
 factors.push(gltf.materials[p.material].pbrMetallicRoughness.baseColorFactor);
 for(let i=0;i<indices.length;i+=3){const a=indices[i]!,normal=cross(positions[a]!,positions[indices[i+1]!]!,positions[indices[i+2]!]!);assert.ok(normal.reduce((s,n,j)=>s+n*normals[a]![j]!,0)>0);}
 }
 assert.equal(triangles,20);assert.ok(factors.some(c=>c[0]===1&&c[1]===0));assert.ok(factors.some(c=>c[0]===0&&c[1]===1));
}));

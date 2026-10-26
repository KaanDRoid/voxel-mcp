import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as sceneIO from '../src/scene.js';
import { loadVOX } from '../src/vox.js';
function ints(...v:number[]) { const b=Buffer.alloc(v.length*4); v.forEach((n,i)=>b.writeInt32LE(n,i*4)); return b; }
function chunk(id:string,c:Buffer,children:Buffer[] = []) { const h=Buffer.alloc(12); h.write(id); h.writeUInt32LE(c.length,4); h.writeUInt32LE(children.reduce((n,b)=>n+b.length,0),8); return Buffer.concat([h,c,...children]); }
function file(c:Buffer[]) { return Buffer.concat([Buffer.from('VOX '),ints(150),chunk('MAIN',Buffer.alloc(0),c)]); }
const pair=()=>[chunk('SIZE',ints(1,1,1)),chunk('XYZI',Buffer.from([1,0,0,0,0,0,0,1]))];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scene-tests-')); process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
function dict(d:Record<string,string>) { const parts=[ints(Object.keys(d).length)]; for(const [k,v] of Object.entries(d)) for(const s of [k,v]) {const b=Buffer.from(s); parts.push(ints(b.length),b);} return Buffer.concat(parts); }
const graph=()=>[
 chunk('nTRN',Buffer.concat([ints(0),dict({_name:'root'}),ints(1,-1,2,1),dict({_t:'1 2 3',_r:'4'})])),
 chunk('nGRP',Buffer.concat([ints(1),dict({}),ints(1,3)])),
 chunk('nSHP',Buffer.concat([ints(3),dict({}),ints(1,0),dict({})])),
 chunk('LAYR',Buffer.concat([ints(2),dict({_name:'layer'}),ints(-1)])),
 chunk('MATL',Buffer.concat([ints(1),dict({_type:'_metal',_rough:'0.25'})]))
];
test('lists and edits transform/group/shape/layer/material metadata using official layout',()=> {
 const bytes=file([...pair(),...graph()]); const s=sceneIO.decodeVOXScene(bytes);
 assert.equal(s.nodes.length,3); assert.equal(s.layers[0]!.attributes._name,'layer'); assert.equal(s.materials[0]!.attributes._rough,'0.25');
 assert.equal(sceneIO.listScene(s).models.length,1); assert.deepEqual(sceneIO.encodeVOXScene(s),bytes);
 sceneIO.setSceneNodeAttributes(s,0,{_name:'renamed'}); sceneIO.setSceneTransform(s,0,[4,-5,6],4);
 const out=sceneIO.encodeVOXScene(s); assert.ok(out.includes(Buffer.from('4 -5 6'))); assert.ok(out.includes(Buffer.from('renamed')));
 const parsed=sceneIO.decodeVOXScene(out); assert.equal(parsed.nodes[0]!.attributes._name,'renamed');
 assert.throws(()=>sceneIO.setSceneTransform(s,1,[0,0,0])); assert.throws(()=>sceneIO.setSceneTransform(s,0,[0.5,0,0])); assert.throws(()=>sceneIO.setSceneTransform(s,0,[0,0,0],0));
});
test('rejects invalid scene metadata lengths, counts, references, cycles and duplicate IDs',()=> {
 for(const c of [chunk('nTRN',ints(0)),chunk('nGRP',Buffer.concat([ints(0),dict({}),ints(-1)])),chunk('nSHP',Buffer.concat([ints(0),dict({}),ints(1,99),dict({})]))]) assert.throws(()=>sceneIO.decodeVOXScene(file([...pair(),c])));
 assert.throws(()=>sceneIO.decodeVOXScene(file([...pair(),...graph(),graph()[0]!])));
 assert.throws(()=>sceneIO.decodeVOXScene(file([...pair(),chunk('nGRP',Buffer.concat([ints(0),dict({}),ints(1,0)]))])));
});
test('creates scenes with shared 1-based palette and rejects incompatible model palettes',()=> {
 const palette=new Uint32Array(256); palette[1]=0x44332211; palette[255]=0xff778899;
 const m={sizeX:1,sizeY:1,sizeZ:1,voxels:[{x:0,y:0,z:0,i:1}],palette};
 const s=sceneIO.createVOXScene([m,{...m,voxels:[{x:0,y:0,z:0,i:255}]}]);
 const bytes=sceneIO.encodeVOXScene(s); const rgba=bytes.indexOf('RGBA')+12;
 assert.equal(bytes.readUInt32LE(rgba),0x44332211); assert.equal(bytes.readUInt32LE(rgba+254*4),0xff778899);
 assert.equal(sceneIO.decodeVOXScene(bytes).models.length,2);
 const other=new Uint32Array(palette); other[1]=1; s.models[1]!.palette=other;
 assert.throws(()=>sceneIO.encodeVOXScene(s),/palette/i); assert.throws(()=>sceneIO.createVOXScene([]));
});
test('does not insert PACK into existing modern scenes and preserves unused RGBA bytes',()=> {
 const rgba=Buffer.alloc(1024); rgba.writeUInt32LE(0x44332211,0); rgba.writeUInt32LE(0xdeadbeef,1020);
 const bytes=file([...pair(),...pair(),chunk('RGBA',rgba)]); bytes.writeUInt32LE(200,4);
 const scene=sceneIO.decodeVOXScene(bytes); assert.deepEqual(sceneIO.encodeVOXScene(scene),bytes);
 scene.models.forEach(m=>m.palette![1]=0xffabcdef);
 const edited=sceneIO.encodeVOXScene(scene); const off=edited.indexOf('RGBA')+12;
 assert.equal(edited.readUInt32LE(off),0xffabcdef); assert.equal(edited.readUInt32LE(off+1020),0xdeadbeef);
});
test('multi-model scene retains unknown nested chunks byte-for-byte and rejects ambiguous loadVOX',()=> {
 const unknown=chunk('TEST',Buffer.from([0,255,33]),[chunk('nest',Buffer.from([42]))]);
 const bytes=file([chunk('PACK',ints(2)),...pair(),unknown,...pair()]);
 const scene=sceneIO.decodeVOXScene(bytes); assert.equal(scene.models.length,2); assert.deepEqual(sceneIO.encodeVOXScene(scene),bytes);
 scene.models[1]!.voxels[0]!.i=255;
 const edited=sceneIO.encodeVOXScene(scene); assert.ok(edited.includes(unknown));
 const second=edited.indexOf('XYZI',edited.indexOf('XYZI')+4); assert.equal(edited[second+19],255);
 const p=path.join(dir,'multi.vox'); fs.writeFileSync(p,bytes); assert.throws(()=>loadVOX(p),/multiple models|ambiguous/i);
 sceneIO.saveVOXScene(p,scene); assert.equal(sceneIO.loadVOXScene(p).models[1]!.voxels[0]!.i,255);
});

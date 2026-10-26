import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPalette, encodeVOX, loadVOX } from '../src/vox.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-tests-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
export function load(bytes: Buffer) { const p = path.join(dir, 'test.vox'); fs.writeFileSync(p, bytes); return loadVOX(p); }
export function chunk(id: string, content: Buffer, children: Buffer[] = []) { const h = Buffer.alloc(12); h.write(id); h.writeUInt32LE(content.length, 4); h.writeUInt32LE(children.reduce((n,b)=>n+b.length,0),8); return Buffer.concat([h,content,...children]); }
export function file(children: Buffer[]) { const h = Buffer.alloc(8); h.write('VOX '); h.writeUInt32LE(150,4); return Buffer.concat([h,chunk('MAIN',Buffer.alloc(0),children)]); }
export function ints(...values: number[]) { const b=Buffer.alloc(values.length*4); values.forEach((v,i)=>b.writeInt32LE(v,i*4)); return b; }
export const model = {sizeX: 2, sizeY: 3, sizeZ: 4, voxels: [{x:1,y:2,z:3,i:255}]};
test('rejects invalid writer sizes, coordinates, palette indexes and palette length',()=> {
 for (const n of [0,257,1.5,NaN,Infinity]) assert.throws(()=>encodeVOX({...model,sizeX:n}));
 for (const v of [{x:-1,y:0,z:0,i:1},{x:2,y:0,z:0,i:1},{x:0.5,y:0,z:0,i:1},{x:0,y:0,z:0,i:0},{x:0,y:0,z:0,i:256}]) assert.throws(()=>encodeVOX({...model,voxels:[v]}));
 assert.throws(()=>encodeVOX({...model,palette:new Uint32Array(255)}));
 assert.doesNotThrow(()=>encodeVOX({...model,sizeX:256,voxels:[{x:255,y:0,z:0,i:255}]}));
});
test('rejects malformed chunk boundaries, counts and model layout',()=> {
 const good=file([chunk('SIZE',ints(2,3,4)),chunk('XYZI',ints(0))]);
 for(let i=0;i<good.length;i++) assert.throws(()=>load(good.subarray(0,i)),`truncation ${i}`);
 for(const children of [[],[chunk('SIZE',ints(0,1,1)),chunk('XYZI',ints(0))],[chunk('SIZE',ints(257,1,1)),chunk('XYZI',ints(0))],[chunk('XYZI',ints(0))],[chunk('SIZE',ints(1,1,1))],[chunk('SIZE',ints(1,1,1)),chunk('XYZI',ints(2))],[chunk('SIZE',ints(1,1,1)),chunk('XYZI',Buffer.from([1,0,0,0,1,0,0,1]))],[chunk('SIZE',ints(1,1,1)),chunk('XYZI',Buffer.from([1,0,0,0,0,0,0,0]))]]) assert.throws(()=>load(file(children)));
 assert.throws(()=>load(Buffer.concat([good,Buffer.from([0])])));
});
test('uses official default palette and maps file RGBA slots to indexes 1..255',()=> {
 const p=defaultPalette(); assert.equal(p[0],0); assert.equal(p[1],0xffffffff); assert.equal(p[2],0xffccffff); assert.equal(p[215],0xff330000); assert.equal(p[255],0xff111111);
 const rgba=Buffer.alloc(1024); rgba.writeUInt32LE(0x44332211,0); rgba.writeUInt32LE(0x88776655,254*4); rgba.writeUInt32LE(0xdeadbeef,255*4);
 const read=load(file([chunk('SIZE',ints(2,3,4)),chunk('XYZI',Buffer.from([1,0,0,0,1,2,3,255])),chunk('RGBA',rgba)]));
 assert.equal(read.palette![0],0); assert.equal(read.palette![1],0x44332211); assert.equal(read.palette![255],0x88776655);
 const custom=new Uint32Array(256); custom[1]=0x44332211; custom[255]=0x88776655;
 const out=encodeVOX({...model,palette:custom}); const off=out.indexOf('RGBA')+12;
 assert.deepEqual([...out.subarray(off,off+4)],[0x11,0x22,0x33,0x44]); assert.equal(out.readUInt32LE(off+254*4),0x88776655); assert.equal(out.readUInt32LE(off+255*4),0);
});
test('reads SIZE and XYZI inside MAIN independently built bytes',()=> { assert.deepEqual(load(file([chunk('SIZE',ints(2,3,4)),chunk('XYZI',Buffer.from([1,0,0,0,1,2,3,255]))])).voxels,model.voxels); });

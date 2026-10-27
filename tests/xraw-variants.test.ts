import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeXRAW,decodeXRAW} from '../src/formats/xraw.js';

test('direct-color XRAW export and import preserve nonzero partial alpha exactly',()=>{
 const palette=new Uint32Array(256);palette[1]=0x7f1450ff;
 const m={sizeX:2,sizeY:1,sizeZ:1,palette,voxels:[{x:1,y:0,z:0,i:1}]};
 const b=encodeXRAW(m,{encoding:'rgba8'});
 assert.deepEqual([...b.subarray(4,8)],[0,4,8,0]);assert.equal(b.readUInt32LE(20),0);assert.equal(b.length,32);
 assert.deepEqual([...b.subarray(28,32)],[255,80,20,127]);const out=decodeXRAW(b).model;assert.equal(out.palette![out.voxels[0]!.i],palette[1]);
});
test('indexed XRAW refuses missing palette entries and trailing data before creating voxels',()=>{
 const b=Buffer.alloc(24+1+4);b.write('XRAW');b.set([0,4,8,8],4);for(const p of [8,12,16,20])b.writeUInt32LE(1,p);b[24]=1;
 assert.throws(()=>decodeXRAW(b),/palette index/i);
 b[24]=0;assert.throws(()=>decodeXRAW(Buffer.concat([b,Buffer.from([1])])),/length|trailing/i);
});

function directFixture(x:number,y:number,z:number):Buffer {
 const b=Buffer.alloc(24+x*y*z*4);b.write('XRAW');b.set([0,4,8,0],4);
 [x,y,z].forEach((n,i)=>b.writeUInt32LE(n,8+i*4));return b;
}
test('high-color XRAW reports partial-alpha reduction even when RGB has only two colors',()=>{
 const b=directFixture(256,1,1);
 for(let i=0;i<256;i++)b.set(i<128?[255,0,0,i%128+1]:[0,0,255,i%128+1],24+i*4);
 const result=decodeXRAW(b);assert.equal(result.model.voxels.length,256);
 assert.ok(result.warnings.some(w=>/alpha.*discarded/i.test(w)));
 assert.ok(result.model.voxels.every(v=>(result.model.palette![v.i]!>>>24)===255));
});
test('XRAW high-color histogram refuses its first over-budget entry',()=>{
 const b=directFixture(256,256,2);
 for(let i=0;i<65537;i++)b.writeUInt32LE((0xff000000|i)>>>0,24+i*4);
 assert.throws(()=>decodeXRAW(b),/high-color allocation budget/i);
});
test('XRAW occupancy rejection precedes voxel-object materialization',()=>{
 const b=directFixture(256,256,32);b.fill(Buffer.from([1,2,3,255]),24);
 const original=Array.prototype.push;
 Array.prototype.push=function<T>(this:T[],...items:T[]):number {
  if(items.some(v=>v!==null&&typeof v==='object'&&'x' in v&&'y' in v&&'z' in v))throw Error('voxel materialized before limit');
  return original.apply(this,items);
 };
 try{assert.throws(()=>decodeXRAW(b),/XRAW voxel budget/i);}finally{Array.prototype.push=original;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/model.js';
test('scale resamples occupied cells into solid volume and preserves independent palettes', () => {
 const a=model(2,1,1); a.palette=new Uint32Array(256);a.palette[0]=0xff112233;m.setVoxels(a,[{x:0,y:0,z:0,i:1}]);
 const b=m.scaleModel(a,2,3,2);assert.deepEqual([b.sizeX,b.sizeY,b.sizeZ],[4,3,2]);assert.equal(b.voxels.length,12);
 assert.ok(b.voxels.every(v=>v.x<2)); assert.notEqual(b.palette,a.palette);assert.equal(b.palette![0],a.palette[0]);
 const c=m.scaleModel(b,0.5,1/3,0.5);assert.deepEqual(c.voxels,[{x:0,y:0,z:0,i:1}]);
 for(const factor of [0,-1,NaN,Infinity,257])assert.throws(()=>m.scaleModel(a,factor,1,1));
});
import type { VoxModelData } from '../src/vox.js';
test('rotations and remaining model transforms normalize plain arrays and reject invalid axes', () => {
 const a=model();a.voxels=[{x:0,y:0,z:0,i:1},{x:0,y:0,z:0,i:2},{x:1,y:0,z:0,i:3}];m.rotate90(a,'z');assert.equal(a.voxels.length,2);
 m.rotateArbitrary(a,'z',45);assert.equal(new Set(a.voxels.map(v=>`${v.x},${v.y},${v.z}`)).size,a.voxels.length);
 assert.throws(()=>m.rotateArbitrary(a,'z',NaN));assert.throws(()=>m.flipModel(a,'bad' as any));
 const b=model();b.voxels=[{x:1,y:1,z:1,i:1},{x:1,y:1,z:1,i:2}];m.flipModel(b,'x');assert.equal(b.voxels.length,1);m.cropToContent(b);assert.deepEqual([b.sizeX,b.sizeY,b.sizeZ],[1,1,1]);
});
test('registry transactions rollback IDs and edits, globally undo/redo and enforce bounded registry', async () => {
 const r=new m.ModelRegistry({maxModels:2,maxTotalVoxels:3,historyLimit:2,maxHistoryVoxels:10});
 for(const size of [0,257,NaN,1.1])assert.throws(()=>r.create(size,1,1));
 const {id}=r.create(3,1,1);
 await r.transaction(async()=>{m.setVoxels(r.get(id),[{x:0,y:0,z:0,i:1}]);r.create(1,1,1);});
 assert.equal(r.list().length,2);assert.equal(r.undo(),true);assert.equal(r.list().length,1);assert.equal(r.get(id).voxels.length,0);
 assert.equal(r.redo(),true);assert.equal(r.list().length,2);assert.equal(r.get(id).voxels.length,1);
 await assert.rejects(r.transaction(async()=>{r.delete('2');r.create(1,1,1);r.get(id).voxels.push({x:0,y:0,z:0,i:3});throw Error('failure');}));
 assert.equal(r.list()[1]!.id,'2');assert.equal(r.get(id).voxels[0]!.i,1);
 r.delete('2');assert.equal(r.create(1,1,1).id,'3');
 await assert.rejects(r.transaction(async()=>{r.get(id).voxels.push({x:1,y:0,z:0,i:0});}));assert.equal(r.get(id).voxels.length,1);
 assert.throws(()=>r.create(1,1,1));
 const q=new m.ModelRegistry({maxTotalVoxels:1});const item=q.create(2,1,1);
 await assert.rejects(q.transaction(async()=>{m.fillBox(q.get(item.id),0,0,0,1,0,0,1);}));assert.equal(q.get(item.id).voxels.length,0);
});
test('translate clips instead of collapsing and error policy is atomic', () => {
 const a=model(3,1,1);m.setVoxels(a,[{x:0,y:0,z:0,i:1},{x:1,y:0,z:0,i:2},{x:2,y:0,z:0,i:3}]);
 m.translate(a,1,0,0);assert.deepEqual(a.voxels,[{x:1,y:0,z:0,i:1},{x:2,y:0,z:0,i:2}]);
 const before=JSON.stringify(a);assert.throws(()=>m.translate(a,1,0,0,'error'));assert.equal(JSON.stringify(a),before);
 m.translate(a,-2,0,0,'expand');assert.equal(a.sizeX,4);assert.deepEqual(a.voxels.map(v=>v.x),[0,1]);
});
const model = (x=4,y=4,z=4): VoxModelData => ({sizeX:x,sizeY:y,sizeZ:z,voxels:[]});
test('direct fills reject oversized candidate boxes and invalid edits atomically', () => {
 const a=model();m.setVoxels(a,[{x:0,y:0,z:0,i:1}]);const before=JSON.stringify(a);
 assert.throws(()=>m.setVoxels(a,[{x:1,y:0,z:0,i:300}]));assert.equal(JSON.stringify(a),before);
 assert.throws(()=>m.pasteRegion(a,[{x:0,y:0,z:0,i:1}],0.5,0,0));assert.equal(JSON.stringify(a),before);
 assert.throws(()=>m.fillSphere(a,0,0,0,-1,2));
 const big=model(129,129,129);assert.throws(()=>m.fillBox(big,0,0,0,128,128,128,1),/budget|limit/i);assert.equal(big.voxels.length,0);
 assert.throws(()=>m.drawLine(a,0,0,0,Number.MAX_SAFE_INTEGER,0,0,1));
});
test('fill, set and paste overwrite coordinates even after plain array pushes', () => {
 const a=model(); a.voxels.push({x:1,y:1,z:1,i:1},{x:1,y:1,z:1,i:2});
 m.fillBox(a,1,1,1,1,1,1,3); assert.deepEqual(a.voxels,[{x:1,y:1,z:1,i:3}]);
 m.setVoxels(a,[{x:1,y:1,z:1,i:4}]); m.pasteRegion(a,[{x:0,y:0,z:0,i:5}],1,1,1);
 assert.deepEqual(a.voxels,[{x:1,y:1,z:1,i:5}]);
});
test('clipped fills do not paint wholly outside shapes and all primitives overwrite', () => {
 const a=model(); m.fillBox(a,8,0,0,9,2,2,1); assert.equal(a.voxels.length,0);
 m.fillCylinder(a,1,1,9,10,1,1); assert.equal(a.voxels.length,0);
 const fills=[()=>m.fillSphere(a,1.5,1.5,1.5,1.5,2),()=>m.fillCylinder(a,1.5,1.5,0,2,1.5,3),()=>m.fillPyramid(a,-8,0,0,-5,2,3,4),()=>m.fillCone(a,1,1,-1,2,4,5),()=>m.fillTorus(a,1.5,1.5,1.5,1,0.5,6),()=>m.drawLine(a,0,0,0,3,3,3,7)];
 for(const fill of fills){fill();fill(); assert.equal(new Set(a.voxels.map(v=>`${v.x},${v.y},${v.z}`)).size,a.voxels.length); for(const v of a.voxels)assert.ok([v.x,v.y,v.z].every(n=>Number.isInteger(n)&&n>=0&&n<4));}
});


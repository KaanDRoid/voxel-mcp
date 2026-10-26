import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.js';
test('flood fill supports empty space, erase, and indices beyond Int16 range', () => {
 const a=model(40,40,24);m.fillBox(a,0,0,0,39,39,23,1);assert.equal(ops.floodFill(a,39,39,23,1,2),38400);assert.ok(a.voxels.every(v=>v.i===2));
 const b=model(3,1,1);b.voxels=[{x:1,y:0,z:0,i:1}];assert.equal(ops.floodFill(b,0,0,0,0,3),1);assert.equal(b.voxels.length,2);
 assert.equal(ops.floodFill(b,1,0,0,1,0),1);assert.ok(b.voxels.every(v=>v.i!==0));
 assert.equal(ops.floodFill(b,0,0,0,3,3),0);assert.throws(()=>ops.floodFill(b,0.5,0,0,0,1));
});
import * as m from '../src/model.js';
import * as analysis from '../src/analysis.js';
test('morphology rejects invalid iterations and excessive work before mutation', () => {
 for(const operation of [ops.erode,ops.dilate,ops.smoothModel])for(const iterations of [-1,1.5,NaN])assert.throws(()=>operation(model(),iterations));
 for(const operation of [ops.erode,ops.dilate,ops.smoothModel]){const a=model(256,256,256);assert.throws(()=>operation(a,100),/budget|limit/i);assert.equal(a.voxels.length,0);}
 assert.throws(()=>ops.extrudeFace(model(),'x',1.5));assert.throws(()=>ops.hollow(model(),NaN));
 const a=model(5,5,5);a.voxels=[{x:2,y:2,z:2,i:4},{x:2,y:2,z:2,i:5}];ops.dilate(a);assert.equal(a.voxels.length,7);assert.ok(a.voxels.every(v=>v.i===5));
 ops.erode(a);assert.deepEqual(a.voxels,[{x:2,y:2,z:2,i:5}]);
 const b=model(3,3,3);m.fillBox(b,0,0,0,2,2,2,9);ops.hollow(b);assert.equal(b.voxels.length,26);
 const c=model(3,3,3);m.fillBox(c,0,0,0,2,2,2,11);ops.smoothModel(c);assert.ok(c.voxels.every(v=>v.i===11));
});
test('booleans use correct dimensions and remap distinct custom colors without altering inputs', () => {
 const a=model(2,3,2),b=model(4,1,1);a.palette=new Uint32Array(256);b.palette=new Uint32Array(256);a.palette[1]=0xff0000ff;b.palette[1]=0xffff0000;
 a.voxels=[{x:0,y:0,z:0,i:1}];b.voxels=[{x:0,y:0,z:0,i:1},{x:3,y:0,z:0,i:1}];
 const u=m.booleanOp(a,b,'union');assert.deepEqual([u.sizeX,u.sizeY,u.sizeZ],[4,3,2]);assert.equal(u.voxels.length,2);
 assert.equal(u.palette![u.voxels[0]!.i],a.palette[1]);assert.equal(u.palette![u.voxels[1]!.i],b.palette[1]);assert.notEqual(u.voxels[0]!.i,u.voxels[1]!.i);
 const intersection=m.booleanOp(a,b,'intersect');assert.deepEqual([intersection.sizeX,intersection.sizeY,intersection.sizeZ],[2,1,1]);assert.equal(intersection.palette![intersection.voxels[0]!.i],a.palette[1]);
 const difference=m.booleanOp(b,a,'difference');assert.equal(difference.sizeX,4);assert.equal(difference.palette![difference.voxels[0]!.i],b.palette[1]);
 assert.equal(b.voxels[1]!.i,1);assert.throws(()=>m.booleanOp(a,b,'bad' as any));
 const many=model(256,1,1);many.palette=new Uint32Array(256);for(let i=1;i<256;i++){many.palette[i]=0xff000000+i;many.voxels.push({x:i-1,y:0,z:0,i});}
 const extra=model(256,1,1);extra.palette=new Uint32Array(256);extra.palette[1]=0xff112233;extra.voxels=[{x:255,y:0,z:0,i:1}];assert.throws(()=>m.booleanOp(many,extra,'union'),/palette|colors/i);
});
import type { VoxModelData } from '../src/vox.js';
test('analysis counts unique occupied cells without modifying raw arrays', () => {
 const a=model();a.voxels=[{x:0,y:0,z:0,i:1},{x:0,y:0,z:0,i:2},{x:1,y:0,z:0,i:1},{x:9,y:0,z:0,i:1}];
 assert.equal(analysis.getVolume(a),2);assert.equal(analysis.getSurfaceArea(a),10);assert.deepEqual(analysis.findCenter(a),[0.5,0,0]);assert.deepEqual(analysis.countColors(a),{1:1,2:1});assert.deepEqual(analysis.getDimensions(a),{min:[0,0,0],max:[1,0,0]});assert.equal(a.voxels.length,4);
 assert.throws(()=>analysis.getSurfaceArea(model(1000)));assert.throws(()=>analysis.measureDistance([NaN,0,0],[0,0,0]));
});
const model = (x=4,y=4,z=4): VoxModelData => ({sizeX:x,sizeY:y,sizeZ:z,voxels:[]});
test('remaining editing operations preserve valid unique cells and reject invalid color/noise parameters', () => {
 const a=model();a.voxels=[{x:1,y:1,z:1,i:2},{x:2,y:1,z:1,i:3}];ops.mirror(a,'x');assert.equal(a.voxels.length,2);
 ops.applyNoise(a,1,100,3);assert.equal(new Set(a.voxels.map(v=>`${v.x},${v.y},${v.z}`)).size,a.voxels.length);
 ops.generateTree(a,-1,0,-3,'oak',2);for(const v of a.voxels)assert.ok([v.x,v.y,v.z].every(n=>Number.isInteger(n)&&n>=0&&n<4));
 assert.equal(new Set(a.voxels.map(v=>`${v.x},${v.y},${v.z}`)).size,a.voxels.length);
 for(const operation of [()=>ops.replaceColor(a,2,0),()=>ops.applyGradient(a,'x',0,2),()=>ops.applyPattern(a,'checker',[],1),()=>ops.applyNoise(a,0,1,1),()=>ops.generateTerrain(a,{octaves:NaN,persistence:0.5,scale:1,seed:0})])assert.throws(operation);
 const duplicate=model();duplicate.voxels=[{x:1,y:0,z:0,i:1},{x:1,y:0,z:0,i:2}];ops.outline(duplicate);assert.equal(duplicate.voxels.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { renderFrameToPNG, exportAnimationGIF, exportAnimationFrames, exportAnimationSpriteSheet, interpolateFrames } from '../src/animation.js';
import type { VoxModelData } from '../src/vox.js';
const palette = new Uint32Array(256); palette[1] = 0xffff0000; palette[200] = 0xff00ff00;
const frame: VoxModelData = {sizeX:2,sizeY:3,sizeZ:4,palette,voxels:[{x:0,y:0,z:0,i:200},{x:0,y:0,z:3,i:1}]};
const pixel = (png: ReturnType<typeof renderFrameToPNG>,x:number,y:number) => [...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
// Minimal independent GIF parser/LZW decoder: assertions inspect encoded pixels, not file existence.
function decodeGIF(bytes: Buffer) {
 assert.equal(bytes.toString('ascii',0,6),'GIF89a');
 const width=bytes.readUInt16LE(6), height=bytes.readUInt16LE(8);
 let p=13; const table=(n:number)=>{const t=Array.from({length:n},()=>{const c=[...bytes.subarray(p,p+3)];p+=3;return c;});return t;};
 const global=bytes[10]!&128 ? table(1<<((bytes[10]!&7)+1)):[];
 const blocks=()=>{const a:number[]=[];let n:number;while((n=bytes[p++]!)!==0){a.push(...bytes.subarray(p,p+n));p+=n;}return a;};
 let delay=0, transparent=-1, loop:number|undefined;
 const frames:{width:number;height:number;delay:number;pixels:number[][]}[]=[];
 while(bytes[p]!==0x3b){const tag=bytes[p++]; if(tag===0x21){const ext=bytes[p++]; if(ext===0xf9){p++;const flags=bytes[p++]!; delay=bytes.readUInt16LE(p)*10;p+=2;transparent=flags&1?bytes[p]!: -1;p+=2;} else {const data=blocks(); if(ext===0xff && Buffer.from(data.slice(0,11)).toString()==='NETSCAPE2.0')loop=data[12]!|(data[13]!<<8);} }
 else if(tag===0x2c){p+=4;const w=bytes.readUInt16LE(p),h=bytes.readUInt16LE(p+2);p+=4;const flags=bytes[p++]!;const pal=flags&128?table(1<<((flags&7)+1)):global;
 const min=bytes[p++]!, data=blocks(),clear=1<<min,end=clear+1;let bits=0,size=min+1,next=end+1,prev:number[]|undefined,dict:number[][]=[];const out:number[]=[];
 const reset=()=>{dict=Array.from({length:clear},(_,i)=>[i]);size=min+1;next=end+1;prev=undefined;};reset();
 while(bits+size<=data.length*8){let code=0;for(let b=0;b<size;b++,bits++)code|=((data[bits>>3]!>>(bits&7))&1)<<b;
 if(code===clear){reset();continue;}if(code===end)break;
 const entry=dict[code]??(code===next && prev?[...prev,prev[0]!]:undefined);assert.ok(entry,'valid LZW dictionary code');out.push(...entry);
 if(prev){dict[next++]=[...prev,entry[0]!];if(next===(1<<size)&&size<12)size++;}prev=entry;
 }assert.equal(out.length,w*h);frames.push({width:w,height:h,delay,pixels:out.map(i=>[...pal[i]!,i===transparent?0:255])});
 } else assert.fail(`unexpected GIF block ${tag}`); }
 return {width,height,frames,loop};
}
const temp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(),'voxel-animation-'));
test('interpolation is deterministic coordinate crossfade preserving actual source colors', () => {
 const bPalette=new Uint32Array(palette);bPalette[1]=0xff0000ff;
 const a={...frame,voxels:[{x:0,y:0,z:0,i:1}]}; const b={...frame,palette:bPalette,voxels:[{x:0,y:0,z:0,i:1},{x:1,y:1,z:1,i:200}]};
 const result=interpolateFrames(a,b,7);assert.equal(result.length,7);
 assert.deepEqual(result,interpolateFrames(a,b,7));
 for(const f of result){for(const v of f.voxels){assert.ok((v.x===0&&v.y===0&&v.z===0)||(v.x===1&&v.y===1&&v.z===1));
 const color=f.palette![v.i];assert.ok(color===0xffff0000||color===0xff0000ff||color===0xff00ff00);}}
 const sharedColors=result.map(f=>f.palette![f.voxels.find(v=>v.x===0)!.i]);assert.ok(sharedColors.includes(0xffff0000));assert.ok(sharedColors.includes(0xff0000ff));
 assert.throws(()=>interpolateFrames(a,b,-1),/steps/);assert.deepEqual(interpolateFrames(a,b,0),[]);
});

test('frame export refuses to write through symlinked child entries',(t)=>{
 const dir=temp();try{
 const outside=path.join(dir,'outside.txt');fs.writeFileSync(outside,'keep');const out=path.join(dir,'out');fs.mkdirSync(out);
 try{fs.symlinkSync(outside,path.join(out,'frame_0000.png'));}catch{t.skip('symlink creation not permitted');return;}
 assert.throws(()=>exportAnimationFrames([frame],out),/symlink/);assert.equal(fs.readFileSync(outside,'utf8'),'keep');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('re-exporting frames replaces regular files',()=>{
 const dir=temp();try{exportAnimationFrames([frame],dir);exportAnimationFrames([{...frame,voxels:[]}],dir);
 assert.equal(PNG.sync.read(fs.readFileSync(path.join(dir,'frame_0000.png'))).data.some(v=>v!==0),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('frame folder and sprite sheet export decode to palette colors in ESM', () => {
 const dir=temp();try{
 exportAnimationFrames([frame],dir,'front'); const front=PNG.sync.read(fs.readFileSync(path.join(dir,'frame_0000.png')));
 assert.deepEqual([front.width,front.height],[2,4]);assert.deepEqual(pixel(front,0,0),[255,0,0,255]);
 const file=path.join(dir,'sheet.png');exportAnimationSpriteSheet([frame,frame],file);
 const sheet=PNG.sync.read(fs.readFileSync(file));assert.deepEqual([sheet.width,sheet.height],[4,3]);assert.deepEqual(pixel(sheet,2,2),[255,0,0,255]);
 assert.throws(()=>exportAnimationSpriteSheet([frame,{...frame,sizeX:3}],file),/sizes differ/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('GIF encodes real frames, palettes, transparency, duration and loop setting', () => {
 const dir=temp();try{
 const file=path.join(dir,'anim.gif');
 const a={...frame,sizeX:1,sizeY:1,sizeZ:1,voxels:[{x:0,y:0,z:0,i:1}]};
 const b={...a,voxels:[{x:0,y:0,z:0,i:200}]};
 exportAnimationGIF({name:'test',fps:12,loop:false,frames:[{model:a,durationMs:70},{model:b,durationMs:130},{model:{...a,voxels:[]},durationMs:90}]},file);
 const decoded=decodeGIF(fs.readFileSync(file));
 assert.deepEqual([decoded.width,decoded.height],[1,1]); assert.equal(decoded.loop,undefined);
 assert.deepEqual(decoded.frames.map(f=>f.delay),[70,130,90]);
 assert.deepEqual(decoded.frames.map(f=>f.pixels[0]),[[255,0,0,255],[0,255,0,255],[0,0,0,0]]);
 exportAnimationGIF([a,b],file);assert.equal(decodeGIF(fs.readFileSync(file)).loop,0);
 assert.throws(()=>exportAnimationGIF([a,frame],file),/sizes differ/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('isometric bounds include tall columns, and depth occludes independent of input order', () => {
 const f: VoxModelData = {sizeX:2,sizeY:2,sizeZ:20,palette,voxels:[{x:0,y:0,z:19,i:1},{x:0,y:0,z:0,i:200}]};
 const png = renderFrameToPNG(f,'isometric');
 const colors = Array.from({length:png.width*png.height},(_,i)=>pixel(png,i%png.width,Math.floor(i/png.width))).filter(c=>c[3]);
 assert.ok(colors.some(c=>c[0]===255 && c[1]===0));
 assert.deepEqual(PNG.sync.write(png),PNG.sync.write(renderFrameToPNG({...f,voxels:f.voxels.toReversed()},'isometric')));
});

test('orthographic projection uses actual axes, nearest depth and ARGB palette', () => {
 const top = PNG.sync.read(PNG.sync.write(renderFrameToPNG(frame,'top')));
 assert.deepEqual([top.width,top.height],[2,3]); assert.deepEqual(pixel(top,0,2),[255,0,0,255]);
 const front = renderFrameToPNG(frame,'front'); assert.deepEqual([front.width,front.height],[2,4]); assert.deepEqual(pixel(front,0,0),[255,0,0,255]);
 const side = renderFrameToPNG(frame,'side'); assert.deepEqual([side.width,side.height],[3,4]); assert.deepEqual(pixel(side,0,0),[255,0,0,255]);
});

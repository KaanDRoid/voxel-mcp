import fs from "fs";
import { gzipSync } from "node:zlib";
import { defaultPalette, type VoxModelData } from "./vox.js";

export function exportSTL(model: VoxModelData, path: string) {
  // ASCII STL of exposed faces (each quad -> 2 triangles)
  const sx = model.sizeX, sy = model.sizeY, sz = model.sizeZ;
  const occ = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (const v of model.voxels) if (v.i>0 && v.x>=0&&v.x<sx&&v.y>=0&&v.y<sy&&v.z>=0&&v.z<sz) occ[idx(v.x,v.y,v.z)] = 1;
  const lines: string[] = ["solid vox"];
  const dirs: [number, number, number, [number, number, number][]][] = [
    [1, 0, 0, [[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],
    [-1,0,0, [[0,1,0],[0,0,0],[0,0,1],[0,1,1]]],
    [0, 1, 0, [[1,1,0],[0,1,0],[0,1,1],[1,1,1]]],
    [0,-1, 0, [[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],
    [0, 0, 1, [[0,0,1],[1,0,1],[1,1,1],[0,1,1]]],
    [0, 0,-1, [[0,1,0],[1,1,0],[1,0,0],[0,0,0]]],
  ];
  function facet(n:[number,number,number], a:number[], b:number[], c:number[]) {
    lines.push(`  facet normal ${n[0]} ${n[2]} ${n[1]}`);
    lines.push("    outer loop");
    lines.push(`      vertex ${a[0]} ${a[2]} ${a[1]}`);
    lines.push(`      vertex ${b[0]} ${b[2]} ${b[1]}`);
    lines.push(`      vertex ${c[0]} ${c[2]} ${c[1]}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  for (let z=0; z<sz; z++) for (let y=0; y<sy; y++) for (let x=0; x<sx; x++) {
    if (!occ[idx(x,y,z)]) continue;
    for (const [dx,dy,dz,corners] of dirs) {
      const nx=x+dx, ny=y+dy, nz=z+dz;
      const empty = nx<0||ny<0||nz<0||nx>=sx||ny>=sy||nz>=sz||!occ[idx(nx,ny,nz)];
      if (!empty) continue;
      const v0 = [x+corners[0]![0], y+corners[0]![1], z+corners[0]![2]];
      const v1 = [x+corners[1]![0], y+corners[1]![1], z+corners[1]![2]];
      const v2 = [x+corners[2]![0], y+corners[2]![1], z+corners[2]![2]];
      const v3 = [x+corners[3]![0], y+corners[3]![1], z+corners[3]![2]];
      facet([dx,dy,dz], v0, v2, v1);
      facet([dx,dy,dz], v0, v3, v2);
    }
  }
  lines.push("endsolid vox");
  fs.writeFileSync(path, lines.join("\n"));
}

export function exportGLTF(model: VoxModelData, path: string) {
  const sx=model.sizeX, sy=model.sizeY, sz=model.sizeZ;
  const occupied = new Map<string, number>();
  const key=(x:number,y:number,z:number)=>`${x},${y},${z}`;
  for (const v of model.voxels) if (v.i>0 && Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z) && v.x>=0 && v.x<sx && v.y>=0 && v.y<sy && v.z>=0 && v.z<sz) occupied.set(key(v.x,v.y,v.z),v.i);
  const dirs: [number,number,number,[number,number,number][]][] = [
    [1,0,0,[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],
    [-1,0,0,[[0,1,0],[0,0,0],[0,0,1],[0,1,1]]],
    [0,1,0,[[1,1,0],[0,1,0],[0,1,1],[1,1,1]]],
    [0,-1,0,[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],
    [0,0,1,[[0,0,1],[1,0,1],[1,1,1],[0,1,1]]],
    [0,0,-1,[[0,1,0],[1,1,0],[1,0,0],[0,0,0]]],
  ];
  const positions:number[]=[], normals:number[]=[];
  const groups=new Map<number,number[]>();
  for (const [k,color] of occupied) {
    const [x,y,z]=k.split(",").map(Number) as [number,number,number];
    for (const [dx,dy,dz,corners] of dirs) {
      if (occupied.has(key(x+dx,y+dy,z+dz))) continue;
      const base=positions.length/3;
      for (const [cx,cy,cz] of corners) { positions.push(x+cx,z+cz,y+cy); normals.push(dx,dz,dy); }
      let indices=groups.get(color); if (!indices) {indices=[];groups.set(color,indices);}
      // Swapping Y/Z reflects handedness, so reverse the triangle winding.
      indices.push(base,base+2,base+1,base,base+3,base+2);
    }
  }
  if (!positions.length) {
    fs.writeFileSync(path,JSON.stringify({asset:{version:"2.0"},scenes:[{nodes:[]}],scene:0}));return;
  }
  const indices=[...groups.values()].flat();
  const floats=(data:number[])=>{const b=Buffer.alloc(data.length*4);data.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;};
  const posBuf=floats(positions), normalBuf=floats(normals), indexBuf=Buffer.alloc(indices.length*4);
  indices.forEach((v,i)=>indexBuf.writeUInt32LE(v,i*4));
  const binary=Buffer.concat([posBuf,normalBuf,indexBuf]);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<positions.length;i++){const axis=i%3;min[axis]=Math.min(min[axis]!,positions[i]!);max[axis]=Math.max(max[axis]!,positions[i]!);}
  const accessors: object[]=[
    {bufferView:0,componentType:5126,count:positions.length/3,type:"VEC3",min,max},
    {bufferView:1,componentType:5126,count:normals.length/3,type:"VEC3"},
  ];
  const palette=model.palette??defaultPalette();
  const linear=(byte:number)=>{const c=byte/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;};
  const materials:object[]=[],primitives:object[]=[];
  let offset=0;
  for(const [color,group] of groups){
    const c=palette[color]??0xffffffff;
    materials.push({pbrMetallicRoughness:{baseColorFactor:[linear((c>>>16)&255),linear((c>>>8)&255),linear(c&255),(c>>>24)/255],metallicFactor:0,roughnessFactor:1},alphaMode:(c>>>24)<255?"BLEND":"OPAQUE"});
    const index=accessors.length;
    accessors.push({bufferView:2,byteOffset:offset,componentType:5125,count:group.length,type:"SCALAR"});offset+=group.length*4;
    primitives.push({attributes:{POSITION:0,NORMAL:1},indices:index,material:materials.length-1,mode:4});
  }
  const gltf={
    asset:{version:"2.0"},buffers:[{byteLength:binary.length,uri:`data:application/octet-stream;base64,${binary.toString("base64")}`}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:posBuf.length,target:34962},{buffer:0,byteOffset:posBuf.length,byteLength:normalBuf.length,target:34962},{buffer:0,byteOffset:posBuf.length+normalBuf.length,byteLength:indexBuf.length,target:34963}],
    accessors,materials,meshes:[{primitives}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0,
  };
  fs.writeFileSync(path,JSON.stringify(gltf));
}

/** Legacy MCEdit/WorldEdit Alpha .schematic (gzip NBT), not Sponge .schem.
 * Vox Z becomes Minecraft Y; opaque colors map to the closest of 16 wool dyes.
 * Air remains air; entities, block states and original palette indices are not retained.
 */
export function exportMinecraftSchematic(model: VoxModelData, path: string) {
  const sx=model.sizeX, sy=model.sizeY, sz=model.sizeZ;
  if (![sx,sy,sz].every(n=>Number.isInteger(n)&&n>0&&n<=32767)) throw new Error("schematic dimensions must be 1..32767");
  const volume=sx*sy*sz;
  if (!Number.isSafeInteger(volume) || volume>0x7fffffff) throw new Error("schematic volume too large");
  const blocks=Buffer.alloc(volume),data=Buffer.alloc(volume),palette=model.palette??defaultPalette();
  const wool=[0xf9fffe,0xf9801d,0xc74ebd,0x3ab3da,0xfed83d,0x80c71f,0xf38baa,0x474f52,0x9d9d97,0x169c9c,0x8932b8,0x3c44aa,0x835432,0x5e7c16,0xb02e26,0x1d1d21];
  const nearest=(c:number)=>{
    let best=0,distance=Infinity;
    wool.forEach((w,i)=>{const d=(((c>>>16)&255)-((w>>>16)&255))**2+(((c>>>8)&255)-((w>>>8)&255))**2+((c&255)-(w&255))**2;if(d<distance){distance=d;best=i;}});
    return best;
  };
  for(const v of model.voxels){
    if(v.i<=0||![v.x,v.y,v.z].every(Number.isInteger)||v.x<0||v.x>=sx||v.y<0||v.y>=sy||v.z<0||v.z>=sz)continue;
    const c=palette[v.i]??0,idx=(v.z*sy+v.y)*sx+v.x;
    blocks[idx]=(c>>>24)<128?0:35;data[idx]=blocks[idx]?nearest(c):0;
  }
  const str=(value:string)=>{const b=Buffer.from(value,"utf8"),len=Buffer.alloc(2);len.writeUInt16BE(b.length);return Buffer.concat([len,b]);};
  const tag=(type:number,name:string,payload:Buffer)=>Buffer.concat([Buffer.from([type]),str(name),payload]);
  const short=(n:number)=>{const b=Buffer.alloc(2);b.writeInt16BE(n);return b;};
  const array=(b:Buffer)=>{const len=Buffer.alloc(4);len.writeInt32BE(b.length);return Buffer.concat([len,b]);};
  const nbt=tag(10,"Schematic",Buffer.concat([
    tag(2,"Width",short(sx)),tag(2,"Height",short(sz)),tag(2,"Length",short(sy)),
    tag(8,"Materials",str("Alpha")),tag(7,"Blocks",array(blocks)),tag(7,"Data",array(data)),
    tag(9,"Entities",Buffer.from([10,0,0,0,0])),tag(9,"TileEntities",Buffer.from([10,0,0,0,0])),Buffer.from([0]),
  ]));
  fs.writeFileSync(path,gzipSync(nbt));
}


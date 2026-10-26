import fs from "fs";
import type { VoxModelData } from "./vox.js";

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** Surface sampling of OBJ triangles/convex polygons; Y-up OBJ is converted to Z-up voxels.
 * Materials/textures and volumetric filling are intentionally not imported.
 */
export async function importOBJ(model: VoxModelData, objPath: string) {
  const text = fs.readFileSync(objPath,"utf8");
  const verts:[number,number,number][] = [], faces:number[][]=[];
  for (const line of text.split("\n")) {
    const [kind,...parts]=line.split("#")[0]!.trim().split(/\s+/);
    if(kind==="v") {
      const values=parts.slice(0,3).map(Number);
      if(values.length!==3 || !values.every(Number.isFinite)) throw new Error("invalid OBJ vertex");
      verts.push([values[0]!,values[2]!,values[1]!]);
    } else if(kind==="f") {
      if(parts.length<3) throw new Error("OBJ face requires at least three vertices");
      faces.push(parts.map(p=>{const token=p.split("/")[0]!;const n=Number(token);if(!Number.isInteger(n)||n===0)throw new Error("invalid OBJ face index");return n<0?verts.length+n:n-1;}));
    }
  }
  if(faces.some(f=>f.some(i=>i<0||i>=verts.length)))throw new Error("OBJ face index out of range");
  if(!verts.length||!faces.length)return 0;
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const v of verts)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis]!,v[axis]!);max[axis]=Math.max(max[axis]!,v[axis]!);}
  const dimensions=[model.sizeX,model.sizeY,model.sizeZ];
  const mapped=verts.map(v=>v.map((n,axis)=>((n-min[axis]!)/(max[axis]!-min[axis]!||1))*(dimensions[axis]!-1)));
  const occupied=new Set(model.voxels.map(v=>`${v.x},${v.y},${v.z}`));
  let count=0;
  for(const face of faces)for(let fi=1;fi<face.length-1;fi++){
    const a=mapped[face[0]!]!,b=mapped[face[fi]!]!,c=mapped[face[fi+1]!]!;
    const steps=Math.max(1,Math.ceil(2*Math.max(...a.map((n,i)=>Math.max(Math.abs(n-b[i]!),Math.abs(n-c[i]!),Math.abs(b[i]!-c[i]!))))));
    for(let i=0;i<=steps;i++)for(let j=0;i+j<=steps;j++){
      const k=steps-i-j;
      const [x,y,z]=a.map((n,axis)=>clamp(Math.round((n*i+b[axis]!*j+c[axis]!*k)/steps),0,dimensions[axis]!-1)) as [number,number,number];
      const key=`${x},${y},${z}`;if(occupied.has(key))continue;
      occupied.add(key);model.voxels.push({x,y,z,i:200});count++;
    }
  }
  return count;
}

/** Monochrome filled rect/circle silhouettes only; SVG Y-down is converted to voxel Y-up.
 * No paths, strokes, CSS, transforms or inherited group styling are rasterized.
 */
export function importSVG(model: VoxModelData, svgPath: string, opts: { thickness?: number } = {}) {
  const text = fs.readFileSync(svgPath,"utf8").replace(/<!--[\s\S]*?-->/g, "");
  if (/<(?:path|polygon|polyline|line|ellipse|text|image|use|defs|symbol|style|g)\b|\b(?:transform|style|stroke|class|clip-path|rx|ry)\s*=/i.test(text)) {
    throw new Error("unsupported SVG geometry, styling or transforms: only unstyled filled rect/circle silhouettes are supported");
  }
  const attributes=(source:string)=>{
    const attrs:Record<string,string>={};
    for(const m of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[m[1]!]=m[3]!;
    return attrs;
  };
  const number=(value:string|undefined,fallback=0)=>{
    if(value===undefined)return fallback;
    const n=Number(value.replace(/px$/i,""));if(!Number.isFinite(n))throw new Error("SVG requires finite numeric coordinates");return n;
  };
  const root=attributes(/<svg\b([^>]*)>/i.exec(text)?.[1]??"");
  const vb=root.viewBox?.trim().split(/[\s,]+/).map(Number)??[0,0,number(root.width,100),number(root.height,100)];
  if(vb.length!==4 || !vb.every(Number.isFinite) || vb[2]!<=0 || vb[3]!<=0)throw new Error("invalid SVG viewport");
  const [vx,vy,vw,vh]=vb as [number,number,number,number];
  const thickness=Math.min(model.sizeZ,Math.max(1,Math.floor(opts.thickness??1)));
  const occupied=new Set(model.voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const shapes=[...text.matchAll(/<(rect|circle)\b([^>]*)>/gi)].map(m=>{
    const attrs=attributes(m[2]!);
    return {kind:m[1]!.toLowerCase(),attrs,a:number(attrs.x),b:number(attrs.y),w:number(attrs.width),h:number(attrs.height),cx:number(attrs.cx),cy:number(attrs.cy),r:number(attrs.r)};
  });
  let count=0;
  for(const {kind,attrs,a,b,w,h,cx,cy,r} of shapes){
    if(attrs.fill==="none"||attrs.display==="none"||attrs.visibility==="hidden")continue;
    if(kind==="rect"?(w<=0||h<=0):r<=0)continue;
    for(let row=0;row<model.sizeY;row++)for(let x=0;x<model.sizeX;x++){
      const px=vx+(x+.5)/model.sizeX*vw,py=vy+(row+.5)/model.sizeY*vh;
      const inside=kind==="rect"?px>=a&&px<a+w&&py>=b&&py<b+h:(px-cx)**2+(py-cy)**2<=r*r;
      if(!inside)continue;
      const y=model.sizeY-1-row;
      for(let z=0;z<thickness;z++){
        const key=`${x},${y},${z}`;if(occupied.has(key))continue;
        occupied.add(key);model.voxels.push({x,y,z,i:kind==="rect"?220:230});count++;
      }
    }
  }
  return count;
}


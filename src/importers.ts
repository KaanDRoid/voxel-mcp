import fs from "fs";
import type { VoxModelData } from "./vox.js";

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export async function importOBJ(model: VoxModelData, objPath: string) {
  const text = fs.readFileSync(objPath, "utf8");
  const verts: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("v ")) {
      const [, xs, ys, zs] = t.split(/\s+/);
      verts.push([parseFloat(xs!), parseFloat(ys!), parseFloat(zs!)]);
    } else if (t.startsWith("f ")) {
      const parts = t.split(/\s+/).slice(1).map(p => parseInt(p.split("/")[0]!, 10) - 1);
      if (parts.length >= 3) faces.push([parts[0]!, parts[1]!, parts[2]!]);
    }
  }
  if (verts.length === 0 || faces.length === 0) return 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x,y,z] of verts) { if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z; if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z; }
  const sx = maxX - minX || 1, sy = maxY - minY || 1, sz = maxZ - minZ || 1;
  const map = (x:number,y:number,z:number) => [
    clamp(Math.round(((x - minX) / sx) * (model.sizeX - 1)), 0, model.sizeX - 1),
    clamp(Math.round(((y - minY) / sy) * (model.sizeY - 1)), 0, model.sizeY - 1),
    clamp(Math.round(((z - minZ) / sz) * (model.sizeZ - 1)), 0, model.sizeZ - 1),
  ] as [number,number,number];
  let count = 0;
  // Simple voxelization: sample barycentric grid per triangle
  for (const [a,b,c] of faces) {
    const va = map(...verts[a]!); const vb = map(...verts[b]!); const vc = map(...verts[c]!);
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j + i <= steps; j++) {
        const k = steps - i - j;
        const x = Math.round((va[0] * i + vb[0] * j + vc[0] * k) / steps);
        const y = Math.round((va[1] * i + vb[1] * j + vc[1] * k) / steps);
        const z = Math.round((va[2] * i + vb[2] * j + vc[2] * k) / steps);
        model.voxels.push({ x, y, z, i: 200 });
        count++;
      }
    }
  }
  return count;
}

export function importSVG(model: VoxModelData, svgPath: string, opts: { thickness?: number }) {
  const text = fs.readFileSync(svgPath, "utf8");
  const thickness = Math.max(1, opts.thickness ?? 1);
  const rectRe = /<rect[^>]*x="([^"]+)"[^>]*y="([^"]+)"[^>]*width="([^"]+)"[^>]*height="([^"]+)"/gi;
  const circRe = /<circle[^>]*cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*r="([^"]+)"/gi;
  // Determine viewBox if present
  let vb = /viewBox="([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)"/i.exec(text);
  const vx = vb ? parseFloat(vb[1]!) : 0, vy = vb ? parseFloat(vb[2]!) : 0, vw = vb ? parseFloat(vb[3]!) : 100, vh = vb ? parseFloat(vb[4]!) : 100;
  const mapX = (x:number) => clamp(Math.round(((x - vx) / vw) * (model.sizeX - 1)), 0, model.sizeX - 1);
  const mapY = (y:number) => clamp(Math.round(((y - vy) / vh) * (model.sizeY - 1)), 0, model.sizeY - 1);
  let m: RegExpExecArray | null;
  while ((m = rectRe.exec(text))) {
    const x = parseFloat(m[1]!), y = parseFloat(m[2]!), w = parseFloat(m[3]!), h = parseFloat(m[4]!);
    const x0 = mapX(x), x1 = mapX(x + w), y0 = mapY(y), y1 = mapY(y + h);
    for (let z = 0; z < Math.min(model.sizeZ, thickness); z++)
      for (let yy = Math.min(y0, y1); yy <= Math.max(y0, y1); yy++)
        for (let xx = Math.min(x0, x1); xx <= Math.max(x0, x1); xx++) model.voxels.push({ x: xx, y: yy, z, i: 220 });
  }
  while ((m = circRe.exec(text))) {
    const cx = parseFloat(m[1]!), cy = parseFloat(m[2]!), r = parseFloat(m[3]!);
    const mcx = mapX(cx), mcy = mapY(cy), rr = Math.max(1, Math.round((r / vw) * model.sizeX));
    for (let z = 0; z < Math.min(model.sizeZ, thickness); z++)
      for (let yy = mcy - rr; yy <= mcy + rr; yy++)
        for (let xx = mcx - rr; xx <= mcx + rr; xx++) {
          const dx = xx - mcx, dy = yy - mcy; if (dx*dx + dy*dy <= rr*rr) model.voxels.push({ x: xx, y: yy, z, i: 230 });
        }
  }
}


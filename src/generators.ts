import fs from "fs";
import path from "path";
import { fillBox, fillSphere, fillCylinder, fillCone, fillPyramid, drawLine, clamp } from "./model.js";
import type { VoxModelData, Voxel } from "./vox.js";

// ============== SEEDED RANDOM ==============
function createRng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// ============== IMAGE UTILITIES ==============
type ImageData = { width: number; height: number; data: Uint8Array };

async function loadImage(filePath: string): Promise<ImageData> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    const { PNG } = await import("pngjs");
    const buf = fs.readFileSync(filePath);
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  } else if (ext === ".jpg" || ext === ".jpeg") {
    const jpeg = await import("jpeg-js");
    const buf = fs.readFileSync(filePath);
    const img = (jpeg as any).decode(buf, { useTArray: true });
    return { width: img.width, height: img.height, data: img.data };
  } else {
    throw new Error(`Unsupported image format: ${ext}`);
  }
}

function rgbToPaletteIndex(r: number, g: number, b: number): number {
  // Map RGB to a palette index (1-255)
  // Simple quantization: 6x6x6 color cube + grayscale
  const rq = Math.floor(r / 51); // 0-5
  const gq = Math.floor(g / 51); // 0-5
  const bq = Math.floor(b / 51); // 0-5
  return Math.max(1, Math.min(255, 1 + rq * 36 + gq * 6 + bq));
}

export function generateHouse(model: VoxModelData, opts: { floors: number; style: string; seed: number }) {
  const { sizeX, sizeY, sizeZ } = model;
  const margin = Math.max(2, Math.floor(Math.min(sizeX, sizeY) * 0.05));
  const footprint = {
    x0: margin,
    y0: margin,
    x1: sizeX - 1 - margin,
    y1: sizeY - 1 - margin,
  };
  const floorH = Math.max(4, Math.floor(sizeZ / Math.max(4, opts.floors + 1)));
  const roofH = Math.max(3, Math.floor(floorH * 0.8));
  const wallIndex = 45;
  const windowIndex = 180;
  const doorIndex = 200;
  const roofIndex = 220;

  // Floors
  for (let f = 0; f < opts.floors; f++) {
    const z0 = f * floorH;
    const z1 = Math.min(sizeZ - 1, z0 + floorH - 1);
    // Outer walls shell 1-voxel thick
    for (let z = z0; z <= z1; z++) {
      for (let x = footprint.x0; x <= footprint.x1; x++) {
        model.voxels.push({ x, y: footprint.y0, z, i: wallIndex });
        model.voxels.push({ x, y: footprint.y1, z, i: wallIndex });
      }
      for (let y = footprint.y0; y <= footprint.y1; y++) {
        model.voxels.push({ x: footprint.x0, y, z, i: wallIndex });
        model.voxels.push({ x: footprint.x1, y, z, i: wallIndex });
      }
    }
    // Windows band
    const wy = 2;
    const wz0 = clamp(z0 + Math.floor(floorH * 0.4), 0, sizeZ - 2);
    const wz1 = clamp(wz0 + 1, 0, sizeZ - 1);
    for (let x = footprint.x0 + 2; x <= footprint.x1 - 2; x += 3) {
      for (let z = wz0; z <= wz1; z++) {
        model.voxels.push({ x, y: footprint.y0, z, i: windowIndex });
        model.voxels.push({ x, y: footprint.y1, z, i: windowIndex });
      }
    }
    for (let y = footprint.y0 + 2; y <= footprint.y1 - 2; y += 3) {
      for (let z = wz0; z <= wz1; z++) {
        model.voxels.push({ x: footprint.x0, y, z, i: windowIndex });
        model.voxels.push({ x: footprint.x1, y, z, i: windowIndex });
      }
    }
  }

  // Door (ground floor)
  const dz0 = 1;
  const dz1 = Math.min(sizeZ - 1, Math.floor(floorH * 0.6));
  const dCenter = Math.floor((footprint.x0 + footprint.x1) / 2);
  for (let z = dz0; z <= dz1; z++) {
    for (let x = dCenter - 1; x <= dCenter + 1; x++) {
      model.voxels.push({ x, y: footprint.y0, z, i: doorIndex });
    }
  }

  // Simple gable roof
  const rz0 = opts.floors * floorH;
  const maxSpan = Math.min(sizeX, sizeY) - 2 * margin;
  const half = Math.floor(maxSpan / 2);
  for (let h = 0; h < roofH; h++) {
    const inset = Math.min(half, h);
    for (let x = footprint.x0 + inset; x <= footprint.x1 - inset; x++) {
      model.voxels.push({ x, y: footprint.y0 + inset, z: clamp(rz0 + h, 0, sizeZ - 1), i: roofIndex });
      model.voxels.push({ x, y: footprint.y1 - inset, z: clamp(rz0 + h, 0, sizeZ - 1), i: roofIndex });
    }
    for (let y = footprint.y0 + inset; y <= footprint.y1 - inset; y++) {
      model.voxels.push({ x: footprint.x0 + inset, y, z: clamp(rz0 + h, 0, sizeZ - 1), i: roofIndex });
      model.voxels.push({ x: footprint.x1 - inset, y, z: clamp(rz0 + h, 0, sizeZ - 1), i: roofIndex });
    }
  }
}

export function generateCharacter(model: VoxModelData, opts: { style: string; seed: number }) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const base = 1;
  // Simple humanoid proportions
  // Legs
  fillBox(model, cx - 6, cy - 3, base, cx - 2, cy + 3, base + 10, 60);
  fillBox(model, cx + 2, cy - 3, base, cx + 6, cy + 3, base + 10, 60);
  // Torso
  fillBox(model, cx - 8, cy - 6, base + 10, cx + 8, cy + 6, base + 24, 120);
  // Arms
  fillBox(model, cx - 12, cy - 2, base + 12, cx - 9, cy + 2, base + 20, 80);
  fillBox(model, cx + 9, cy - 2, base + 12, cx + 12, cy + 2, base + 20, 80);
  // Head
  fillBox(model, cx - 5, cy - 5, base + 25, cx + 5, cy + 5, base + 35, 200);
  // Simple eyes
  model.voxels.push({ x: cx - 2, y: cy + 3, z: base + 30, i: 250 });
  model.voxels.push({ x: cx + 2, y: cy + 3, z: base + 30, i: 250 });
}

export function generateVehicle(
  model: VoxModelData,
  opts: { type: "car" | "truck" | "spaceship" | "boat" | "plane" | "tank" | "motorcycle" | "helicopter"; style?: "realistic" | "cartoon" | "lowpoly" | "scifi"; seed?: number }
) {
  const rng = createRng(opts.seed ?? 0);
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);

  const body = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, i: number) =>
    fillBox(model, x0, y0, z0, x1, y1, z1, i);

  switch (opts.type) {
    case "car": {
      const w = Math.floor(sizeX * 0.7), d = Math.floor(sizeY * 0.4), h = Math.floor(sizeZ * 0.25);
      const x0 = Math.max(0, cx - Math.floor(w / 2)), x1 = Math.min(sizeX - 1, cx + Math.floor(w / 2));
      const y0 = Math.max(0, cy - Math.floor(d / 2)), y1 = Math.min(sizeY - 1, cy + Math.floor(d / 2));
      body(x0, y0, 0, x1, y1, h, 100);
      // cabin
      const ch = Math.floor(h * 0.7);
      body(x0 + 3, y0 + 2, h + 1, x1 - 3, y1 - 2, h + 1 + ch, 180);
      // wheels (cylinders)
      const r = Math.max(1, Math.floor(Math.min(w, d) / 6));
      fillCylinder(model, x0 + 3, y0 + 1, 0, r * 2, r, 40);
      fillCylinder(model, x0 + 3, y1 - 1, 0, r * 2, r, 40);
      fillCylinder(model, x1 - 3, y0 + 1, 0, r * 2, r, 40);
      fillCylinder(model, x1 - 3, y1 - 1, 0, r * 2, r, 40);
      break;
    }
    case "spaceship": {
      const l = Math.floor(sizeX * 0.8), d = Math.floor(sizeY * 0.3), h = Math.floor(sizeZ * 0.3);
      const x0 = Math.max(0, cx - Math.floor(l / 2)), x1 = Math.min(sizeX - 1, cx + Math.floor(l / 2));
      const y0 = Math.max(0, cy - Math.floor(d / 2)), y1 = Math.min(sizeY - 1, cy + Math.floor(d / 2));
      body(x0, y0, Math.floor(sizeZ * 0.2), x1, y1, Math.floor(sizeZ * 0.2) + h, 200);
      // wings
      fillBox(model, x0 + 2, y0 - Math.floor(d / 2), Math.floor(sizeZ * 0.2) + Math.floor(h / 2), x0 + 6, y0, Math.floor(sizeZ * 0.2) + Math.floor(h / 2) + 1, 210);
      fillBox(model, x0 + 2, y1, Math.floor(sizeZ * 0.2) + Math.floor(h / 2), x0 + 6, y1 + Math.floor(d / 2), Math.floor(sizeZ * 0.2) + Math.floor(h / 2) + 1, 210);
      // engines
      fillCylinder(model, x1 - 2, cy - 2, Math.floor(sizeZ * 0.2), Math.floor(sizeZ * 0.2) + 3, 2, 230);
      fillCylinder(model, x1 - 2, cy + 2, Math.floor(sizeZ * 0.2), Math.floor(sizeZ * 0.2) + 3, 2, 230);
      break;
    }
    case "boat": {
      const l = Math.floor(sizeX * 0.7), w = Math.floor(sizeY * 0.3), h = Math.floor(sizeZ * 0.2);
      const x0 = Math.max(0, cx - Math.floor(l / 2)), x1 = Math.min(sizeX - 1, cx + Math.floor(l / 2));
      const y0 = Math.max(0, cy - Math.floor(w / 2)), y1 = Math.min(sizeY - 1, cy + Math.floor(w / 2));
      for (let z = 0; z < h; z++) {
        const inset = Math.floor((z / h) * (w / 2));
        for (let y = y0 + inset; y <= y1 - inset; y++) {
          for (let x = x0; x <= x1; x++) model.voxels.push({ x, y, z, i: 90 });
        }
      }
      // cabin
      body(cx - Math.floor(l / 6), y0 + 1, h, cx + Math.floor(l / 6), y1 - 1, h + Math.floor(h / 2), 120);
      break;
    }
    default: {
      // Fallback: simple body block
      fillBox(model, Math.floor(sizeX * 0.2), Math.floor(sizeY * 0.3), 0, Math.floor(sizeX * 0.8), Math.floor(sizeY * 0.7), Math.floor(sizeZ * 0.3), 150);
    }
  }
}

export function generateFurniture(
  model: VoxModelData,
  opts: { type: "chair" | "table" | "bed" | "shelf" | "lamp" | "sofa" | "desk" | "cabinet"; style?: "modern" | "classic" | "medieval" | "scifi"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const base = 0;
  const wood = 90, metal = 200, fabric = 140, light = 250;

  switch (opts.type) {
    case "chair": {
      // seat
      fillBox(model, cx - 3, cy - 3, base + 4, cx + 3, cy + 3, base + 5, fabric);
      // backrest
      fillBox(model, cx - 3, cy + 3, base + 5, cx + 3, cy + 4, base + 10, fabric);
      // legs
      fillCylinder(model, cx - 3, cy - 3, base, base + 4, 1, wood);
      fillCylinder(model, cx + 3, cy - 3, base, base + 4, 1, wood);
      fillCylinder(model, cx - 3, cy + 3, base, base + 4, 1, wood);
      fillCylinder(model, cx + 3, cy + 3, base, base + 4, 1, wood);
      break;
    }
    case "table": {
      // top
      fillBox(model, cx - 6, cy - 4, base + 8, cx + 6, cy + 4, base + 9, wood);
      // legs
      fillCylinder(model, cx - 5, cy - 3, base, base + 8, 1, wood);
      fillCylinder(model, cx + 5, cy - 3, base, base + 8, 1, wood);
      fillCylinder(model, cx - 5, cy + 3, base, base + 8, 1, wood);
      fillCylinder(model, cx + 5, cy + 3, base, base + 8, 1, wood);
      break;
    }
    case "bed": {
      // base + mattress
      fillBox(model, cx - 8, cy - 4, base + 2, cx + 8, cy + 4, base + 3, wood);
      fillBox(model, cx - 8, cy - 4, base + 3, cx + 8, cy + 4, base + 6, fabric);
      // headboard
      fillBox(model, cx - 8, cy + 4, base + 3, cx + 8, cy + 5, base + 9, wood);
      // pillows
      fillBox(model, cx - 5, cy - 1, base + 6, cx - 1, cy + 1, base + 7, 230);
      fillBox(model, cx + 1, cy - 1, base + 6, cx + 5, cy + 1, base + 7, 230);
      break;
    }
    case "shelf": {
      // frame
      fillBox(model, cx - 6, cy - 3, base + 0, cx - 5, cy + 3, base + 12, wood);
      fillBox(model, cx + 5, cy - 3, base + 0, cx + 6, cy + 3, base + 12, wood);
      // shelves
      for (let z = 2; z <= 10; z += 4) fillBox(model, cx - 5, cy - 3, base + z, cx + 5, cy + 3, base + z + 1, wood);
      break;
    }
    case "lamp": {
      // base + stand + shade
      fillCylinder(model, cx, cy, base, base + 1, 2, metal);
      fillCylinder(model, cx, cy, base + 1, base + 8, 1, metal);
      fillCone(model, cx, cy, base + 8, 5, 5, light);
      break;
    }
    case "sofa": {
      fillBox(model, cx - 8, cy - 4, base + 2, cx + 8, cy + 4, base + 5, fabric);
      fillBox(model, cx - 8, cy + 4, base + 5, cx + 8, cy + 5, base + 10, fabric);
      fillBox(model, cx - 8, cy - 5, base + 3, cx - 7, cy + 5, base + 8, fabric);
      fillBox(model, cx + 7, cy - 5, base + 3, cx + 8, cy + 5, base + 8, fabric);
      break;
    }
    case "desk": {
      fillBox(model, cx - 8, cy - 4, base + 8, cx + 8, cy + 4, base + 9, wood);
      // legs/drawers
      fillBox(model, cx - 8, cy - 4, base, cx - 7, cy + 4, base + 8, wood);
      fillBox(model, cx + 7, cy - 4, base, cx + 8, cy + 4, base + 8, wood);
      break;
    }
    case "cabinet": {
      fillBox(model, cx - 6, cy - 4, base, cx + 6, cy + 4, base + 12, wood);
      // doors detail line
      for (let z = base + 2; z < base + 12; z += 2) {
        drawLine(model, cx, cy - 4, z, cx, cy + 4, z, 60);
      }
      break;
    }
  }
}

export function generateWeapon(
  model: VoxModelData,
  opts: { type: "sword" | "axe" | "hammer" | "spear" | "bow" | "gun" | "staff" | "shield" | "dagger"; style?: "medieval" | "fantasy" | "scifi" | "steampunk"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const base = 0;
  const metal = 220, wood = 90, leather = 100;

  switch (opts.type) {
    case "sword": {
      // blade
      fillBox(model, cx - 1, cy, base + 4, cx + 1, cy, base + 18, metal);
      // guard
      fillBox(model, cx - 3, cy - 1, base + 4, cx + 3, cy + 1, base + 5, metal);
      // handle
      fillBox(model, cx - 1, cy, base, cx + 1, cy, base + 4, leather);
      break;
    }
    case "axe": {
      // handle
      fillBox(model, cx - 1, cy, base, cx + 1, cy, base + 14, wood);
      // head
      fillBox(model, cx + 1, cy, base + 10, cx + 5, cy + 3, base + 14, metal);
      fillBox(model, cx + 2, cy - 1, base + 11, cx + 5, cy, base + 13, metal);
      break;
    }
    case "hammer": {
      fillBox(model, cx - 1, cy, base, cx + 1, cy, base + 12, wood);
      fillBox(model, cx - 3, cy - 2, base + 12, cx + 3, cy + 2, base + 16, metal);
      break;
    }
    case "spear": {
      fillBox(model, cx, cy, base, cx, cy, base + 18, wood);
      fillCone(model, cx, cy, base + 18, 2, 4, metal);
      break;
    }
    case "bow": {
      for (let z = base + 4; z <= base + 16; z++) drawLine(model, cx - 4, cy, z, cx + 4, cy, z, wood);
      drawLine(model, cx - 4, cy, base + 4, cx - 4, cy, base + 16, leather);
      drawLine(model, cx + 4, cy, base + 4, cx + 4, cy, base + 16, leather);
      break;
    }
    case "gun": {
      fillBox(model, cx - 4, cy, base + 6, cx + 4, cy + 1, base + 8, metal);
      fillBox(model, cx - 1, cy - 2, base + 2, cx + 1, cy, base + 6, metal);
      break;
    }
    case "staff": {
      fillBox(model, cx, cy, base, cx, cy, base + 18, wood);
      fillSphere(model, cx, cy, base + 18, 2, metal);
      break;
    }
    case "shield": {
      fillBox(model, cx - 6, cy - 1, base + 4, cx + 6, cy + 1, base + 12, metal);
      // boss
      fillSphere(model, cx, cy, base + 8, 2, 230);
      break;
    }
    case "dagger": {
      fillBox(model, cx - 1, cy, base + 4, cx + 1, cy, base + 10, metal);
      fillBox(model, cx - 2, cy - 1, base + 4, cx + 2, cy + 1, base + 5, metal);
      fillBox(model, cx - 1, cy, base, cx + 1, cy, base + 4, leather);
      break;
    }
  }
}

export function generateStructure(
  model: VoxModelData,
  opts: { type: "castle" | "tower" | "bridge" | "wall" | "gate" | "temple" | "pyramid" | "lighthouse"; style?: "medieval" | "asian" | "modern" | "fantasy"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);

  switch (opts.type) {
    case "castle": {
      // outer walls
      const wallI = 100;
      const z0 = 0, z1 = Math.floor(sizeZ * 0.4);
      for (let z = z0; z <= z1; z++) {
        for (let x = 2; x < sizeX - 2; x++) {
          model.voxels.push({ x, y: 2, z, i: wallI });
          model.voxels.push({ x, y: sizeY - 3, z, i: wallI });
        }
        for (let y = 2; y < sizeY - 2; y++) {
          model.voxels.push({ x: 2, y, z, i: wallI });
          model.voxels.push({ x: sizeX - 3, y, z, i: wallI });
        }
      }
      // corner towers
      const tR = 2;
      fillCylinder(model, 2, 2, z0, z1 + 3, tR, 120);
      fillCylinder(model, sizeX - 3, 2, z0, z1 + 3, tR, 120);
      fillCylinder(model, 2, sizeY - 3, z0, z1 + 3, tR, 120);
      fillCylinder(model, sizeX - 3, sizeY - 3, z0, z1 + 3, tR, 120);
      // gate
      for (let z = 1; z < Math.floor(z1 * 0.6); z++) {
        for (let x = cx - 2; x <= cx + 2; x++) model.voxels.push({ x, y: 2, z, i: 200 });
      }
      break;
    }
    case "tower": {
      const r = Math.min(Math.floor(sizeX / 3), Math.floor(sizeY / 3));
      fillCylinder(model, cx, cy, 0, sizeZ - 5, r, 140);
      fillCone(model, cx, cy, sizeZ - 5, r + 1, 5, 180);
      break;
    }
    case "bridge": {
      const deckZ = Math.floor(sizeZ * 0.3);
      // piers
      fillBox(model, cx - 10, cy - 1, 0, cx - 8, cy + 1, deckZ, 100);
      fillBox(model, cx + 8, cy - 1, 0, cx + 10, cy + 1, deckZ, 100);
      // deck
      fillBox(model, cx - 12, cy - 2, deckZ, cx + 12, cy + 2, deckZ + 1, 120);
      // railing
      for (let x = cx - 12; x <= cx + 12; x++) {
        model.voxels.push({ x, y: cy - 2, z: deckZ + 2, i: 150 });
        model.voxels.push({ x, y: cy + 2, z: deckZ + 2, i: 150 });
      }
      break;
    }
    case "pyramid": {
      fillPyramid(model, 2, 2, 0, sizeX - 3, sizeY - 3, Math.floor(sizeZ * 0.8), 160);
      break;
    }
    case "lighthouse": {
      const r = Math.min(Math.floor(sizeX / 4), Math.floor(sizeY / 4));
      fillCylinder(model, cx, cy, 0, sizeZ - 6, r, 200);
      fillBox(model, cx - 2, cy - 2, sizeZ - 6, cx + 2, cy + 2, sizeZ - 4, 230);
      fillCone(model, cx, cy, sizeZ - 4, r + 1, 4, 180);
      break;
    }
    default: {
      // simple wall
      fillBox(model, 2, cy - 1, 0, sizeX - 3, cy + 1, Math.floor(sizeZ * 0.5), 140);
    }
  }
}

export function generateCreature(
  model: VoxModelData,
  opts: { type: "dog" | "cat" | "bird" | "fish" | "dragon" | "horse" | "snake" | "spider" | "robot"; style?: "realistic" | "cute" | "monster" | "cartoon"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const base = 1;

  switch (opts.type) {
    case "dog":
    case "cat": {
      // body + head
      fillSphere(model, cx, cy, base + 6, 5, 120);
      fillSphere(model, cx + 6, cy, base + 8, 3, 120);
      // legs
      fillCylinder(model, cx - 3, cy - 2, base, base + 4, 1, 80);
      fillCylinder(model, cx - 3, cy + 2, base, base + 4, 1, 80);
      fillCylinder(model, cx + 1, cy - 2, base, base + 4, 1, 80);
      fillCylinder(model, cx + 1, cy + 2, base, base + 4, 1, 80);
      // tail
      drawLine(model, cx - 5, cy, base + 8, cx - 8, cy + 1, base + 10, 100);
      break;
    }
    case "bird": {
      fillSphere(model, cx, cy, base + 8, 4, 180);
      // wings
      for (let d = 0; d < 6; d++) drawLine(model, cx, cy, base + 8, cx - 6 + d, cy + 3, base + 8, 180);
      for (let d = 0; d < 6; d++) drawLine(model, cx, cy, base + 8, cx - 6 + d, cy - 3, base + 8, 180);
      // beak
      fillCone(model, cx + 4, cy, base + 8, 2, 2, 230);
      break;
    }
    case "dragon": {
      // serpentine body
      for (let i = 0; i < 6; i++) fillSphere(model, cx - i * 3, cy + ((i & 1) ? 2 : -2), base + 6 + (i % 3), 3, 140);
      // wings
      fillCone(model, cx - 4, cy - 5, base + 10, 4, 6, 100);
      fillCone(model, cx - 4, cy + 5, base + 10, 4, 6, 100);
      break;
    }
    default: {
      // robot/humanoid fallback
      fillBox(model, cx - 3, cy - 2, base, cx + 3, cy + 2, base + 12, 150);
      fillBox(model, cx - 2, cy - 1, base + 12, cx + 2, cy + 1, base + 16, 150);
    }
  }
}

export function generateNature(
  model: VoxModelData,
  opts: { type: "rock" | "crystal" | "cloud" | "mountain" | "island" | "cave" | "mushroom" | "flower"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const base = 0;
  const rng = createRng(opts.seed ?? 0);

  switch (opts.type) {
    case "rock": {
      const n = 4 + Math.floor(rng() * 4);
      for (let k = 0; k < n; k++) {
        const rx = cx + Math.floor((rng() - 0.5) * sizeX * 0.3);
        const ry = cy + Math.floor((rng() - 0.5) * sizeY * 0.3);
        const rz = 2 + Math.floor(rng() * (sizeZ * 0.2));
        const r = 2 + Math.floor(rng() * 4);
        fillSphere(model, rx, ry, rz, r, 100);
      }
      break;
    }
    case "crystal": {
      // hexagonal prism-ish
      const h = Math.floor(sizeZ * 0.6);
      for (let z = 2; z < h; z++) {
        const r = Math.max(2, Math.floor((1 - z / h) * 6) + 2);
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++)
            if (Math.abs(x - cx) + Math.abs(y - cy) < r + ((x + y) & 1)) model.voxels.push({ x, y, z, i: 230 });
      }
      break;
    }
    case "cloud": {
      for (let k = 0; k < 6; k++) fillSphere(model, cx + k - 3, cy + ((k & 1) ? 1 : -1), base + 8 + (k % 2), 4, 240);
      break;
    }
    case "mountain": {
      fillPyramid(model, 2, 2, base, sizeX - 3, sizeY - 3, Math.floor(sizeZ * 0.9), 120);
      // snow cap
      fillPyramid(model, 4, 4, Math.floor(sizeZ * 0.6), sizeX - 5, sizeY - 5, Math.floor(sizeZ * 0.3), 250);
      break;
    }
    default: {
      // simple mushroom
      fillCylinder(model, cx, cy, base, base + 6, 1, 90);
      fillSphere(model, cx, cy, base + 8, 4, 200);
    }
  }
}

// ===== Nightlife Set - City/Interior/Characters =====

export function generateAnkaraBlock(model: VoxModelData, opts: { roads?: boolean; seed?: number }) {
  const { sizeX, sizeY, sizeZ } = model;
  const rng = createRng(opts.seed ?? 42);
  const roadI = 20, buildingI = 100, glassI = 180, neonI = 230;
  if (opts.roads !== false) {
    // Simple grid roads
    for (let x = 0; x < sizeX; x++) {
      for (let y of [Math.floor(sizeY*0.33), Math.floor(sizeY*0.66)]) for (let z = 0; z < 1; z++) model.voxels.push({ x, y, z, i: roadI });
    }
    for (let y = 0; y < sizeY; y++) {
      for (let x of [Math.floor(sizeX*0.25), Math.floor(sizeX*0.5), Math.floor(sizeX*0.75)]) for (let z = 0; z < 1; z++) model.voxels.push({ x, y, z, i: roadI });
    }
  }
  // Buildings on plots
  const plotsX = [1, Math.floor(sizeX*0.25)+1, Math.floor(sizeX*0.5)+1, Math.floor(sizeX*0.75)+1];
  const plotsY = [1, Math.floor(sizeY*0.33)+1, Math.floor(sizeY*0.66)+1];
  for (let px = 0; px < plotsX.length - 1; px++) {
    for (let py = 0; py < plotsY.length - 1; py++) {
      const x0 = plotsX[px]!, x1 = plotsX[px+1]! - 2;
      const y0 = plotsY[py]!, y1 = plotsY[py+1]! - 2;
      const h = 4 + Math.floor(rng() * Math.max(5, sizeZ*0.4));
      // shell
      for (let z=0; z<Math.min(h,sizeZ-1); z++) {
        for (let x=x0; x<=x1; x++) { model.voxels.push({ x, y: y0, z, i: buildingI }); model.voxels.push({ x, y: y1, z, i: buildingI }); }
        for (let y=y0; y<=y1; y++) { model.voxels.push({ x: x0, y, z, i: buildingI }); model.voxels.push({ x: x1, y, z, i: buildingI }); }
      }
      // windows band
      for (let x=x0+2; x<=x1-2; x+=3) for (let z=2; z<Math.min(h-1,sizeZ-1); z+=3) { model.voxels.push({ x, y: y0, z, i: glassI }); model.voxels.push({ x, y: y1, z, i: glassI }); }
      for (let y=y0+2; y<=y1-2; y+=3) for (let z=2; z<Math.min(h-1,sizeZ-1); z+=3) { model.voxels.push({ x: x0, y, z, i: glassI }); model.voxels.push({ x: x1, y, z, i: glassI }); }
      // Chance of neon sign at entrance
      if (rng() < 0.3) {
        const ex = Math.floor((x0+x1)/2);
        const ez = 2;
        for (let dx=-3; dx<=3; dx++) model.voxels.push({ x: ex+dx, y: y0, z: ez, i: neonI });
      }
    }
  }
}

export function generateVenueInterior(model: VoxModelData, opts: { seed?: number }) {
  const { sizeX, sizeY } = model; const base=0;
  // stage
  fillBox(model, 2, 2, base, sizeX-3, 6, base+1, 120);
  // bar
  fillBox(model, sizeX-10, sizeY-6, base, sizeX-3, sizeY-3, base+2, 90);
  // tables
  for (let tx=8; tx<sizeX-12; tx+=8) for (let ty=10; ty<sizeY-8; ty+=8) { fillCylinder(model, tx, ty, base, base+2, 2, 100); }
  // neon lights
  for (let x=3; x<sizeX-3; x+=4) model.voxels.push({ x, y: 3, z: 3, i: 230 });
}

export function generateVenueCharacter(model: VoxModelData, opts: { role: "konsomatris"|"musteri"|"garson"|"asci"|"polis"|"mafya"|"behzatc"; seed?: number }) {
  // Simple humanoid with color scheme per role
  const { sizeX, sizeY, sizeZ } = model; const cx=Math.floor(sizeX/2), cy=Math.floor(sizeY/2), b=1;
  const colors: Record<string, [number,number,number,number,number]> = {
    konsomatris: [200,180,230,250,80], // dress, torso, head, accents, boots
    musteri: [100,120,200,80,60],
    garson: [40,120,200,230,40],
    asci: [120,200,230,200,180],
    polis: [80,120,200,250,40],
    mafya: [40,80,200,230,60],
    behzatc: [80,100,200,230,60],
  };
  const [leg, torso, head, accent, shoe] = colors[opts.role] ?? [60,120,200,230,40];
  // legs
  fillBox(model, cx-3, cy-2, b, cx-1, cy+2, b+9, leg);
  fillBox(model, cx+1, cy-2, b, cx+3, cy+2, b+9, leg);
  // torso
  fillBox(model, cx-5, cy-4, b+9, cx+5, cy+4, b+20, torso);
  // arms
  fillBox(model, cx-8, cy-2, b+11, cx-6, cy+2, b+18, torso);
  fillBox(model, cx+6, cy-2, b+11, cx+8, cy+2, b+18, torso);
  // head
  fillBox(model, cx-3, cy-3, b+21, cx+3, cy+3, b+27, head);
  // accents: badge/tie for police/garson, etc.
  model.voxels.push({ x: cx, y: cy, z: b+15, i: accent });
}

// ===== STAFF CHARACTERS =====
export type StaffType = "barman" | "chef" | "cleaner" | "konsomatris" | "musician" | "security" | "waiter";

export function generateStaff(
  model: VoxModelData,
  opts: { type: StaffType; style?: "default" | "fancy" | "casual"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const b = 1; // base z
  const rng = createRng(opts.seed ?? 0);

  // Color palettes per staff type [skin, pants, shirt, accent, shoes, hair, accessory]
  const staffColors: Record<StaffType, { skin: number; pants: number; shirt: number; accent: number; shoes: number; hair: number; accessory: number }> = {
    barman: { skin: 200, pants: 40, shirt: 230, accent: 250, shoes: 30, hair: 80, accessory: 180 }, // white shirt, black pants, bow tie
    chef: { skin: 200, pants: 230, shirt: 230, accent: 200, shoes: 230, hair: 80, accessory: 250 }, // all white, chef hat
    cleaner: { skin: 200, pants: 100, shirt: 120, accent: 180, shoes: 60, hair: 80, accessory: 230 }, // blue uniform
    konsomatris: { skin: 200, pants: 180, shirt: 200, accent: 250, shoes: 40, hair: 230, accessory: 250 }, // elegant dress, heels
    musician: { skin: 200, pants: 40, shirt: 160, accent: 230, shoes: 40, hair: 100, accessory: 180 }, // casual dark, instrument
    security: { skin: 200, pants: 40, shirt: 40, accent: 250, shoes: 30, hair: 60, accessory: 230 }, // all black, badge
    waiter: { skin: 200, pants: 40, shirt: 230, accent: 200, shoes: 40, hair: 80, accessory: 150 }, // white shirt, black pants, tray
  };

  const c = staffColors[opts.type] ?? staffColors.waiter;

  // === BASE HUMANOID ===
  // Feet/Shoes
  fillBox(model, cx - 3, cy - 2, b, cx - 1, cy + 1, b + 2, c.shoes);
  fillBox(model, cx + 1, cy - 2, b, cx + 3, cy + 1, b + 2, c.shoes);

  // Legs
  fillBox(model, cx - 3, cy - 1, b + 2, cx - 1, cy + 1, b + 10, c.pants);
  fillBox(model, cx + 1, cy - 1, b + 2, cx + 3, cy + 1, b + 10, c.pants);

  // Torso
  fillBox(model, cx - 4, cy - 2, b + 10, cx + 4, cy + 2, b + 20, c.shirt);

  // Neck
  fillBox(model, cx - 1, cy - 1, b + 20, cx + 1, cy + 1, b + 22, c.skin);

  // Head
  fillBox(model, cx - 3, cy - 3, b + 22, cx + 3, cy + 3, b + 30, c.skin);

  // Hair (back and top)
  fillBox(model, cx - 3, cy + 2, b + 26, cx + 3, cy + 3, b + 31, c.hair);
  fillBox(model, cx - 3, cy - 2, b + 30, cx + 3, cy + 3, b + 31, c.hair);

  // Arms
  fillBox(model, cx - 7, cy - 1, b + 12, cx - 5, cy + 1, b + 20, c.shirt);
  fillBox(model, cx + 5, cy - 1, b + 12, cx + 7, cy + 1, b + 20, c.shirt);
  // Hands
  fillBox(model, cx - 7, cy - 1, b + 10, cx - 5, cy + 1, b + 12, c.skin);
  fillBox(model, cx + 5, cy - 1, b + 10, cx + 7, cy + 1, b + 12, c.skin);

  // Eyes
  model.voxels.push({ x: cx - 1, y: cy - 3, z: b + 26, i: 40 });
  model.voxels.push({ x: cx + 1, y: cy - 3, z: b + 26, i: 40 });

  // === TYPE-SPECIFIC DETAILS ===
  switch (opts.type) {
    case "barman": {
      // Bow tie
      fillBox(model, cx - 1, cy - 2, b + 19, cx + 1, cy - 2, b + 20, c.accent);
      // Vest
      fillBox(model, cx - 3, cy - 2, b + 14, cx + 3, cy - 1, b + 18, 60);
      // Holding shaker/bottle
      fillBox(model, cx + 5, cy - 3, b + 6, cx + 7, cy - 1, b + 10, c.accessory);
      break;
    }
    case "chef": {
      // Chef hat (tall white toque)
      fillBox(model, cx - 3, cy - 2, b + 31, cx + 3, cy + 2, b + 38, 250);
      fillBox(model, cx - 2, cy - 1, b + 38, cx + 2, cy + 1, b + 40, 250);
      // Apron
      fillBox(model, cx - 4, cy - 2, b + 10, cx + 4, cy - 2, b + 18, 250);
      // Double-breasted buttons
      model.voxels.push({ x: cx - 1, y: cy - 2, z: b + 16, i: 40 });
      model.voxels.push({ x: cx + 1, y: cy - 2, z: b + 16, i: 40 });
      model.voxels.push({ x: cx - 1, y: cy - 2, z: b + 14, i: 40 });
      model.voxels.push({ x: cx + 1, y: cy - 2, z: b + 14, i: 40 });
      // Holding pan
      fillBox(model, cx - 9, cy - 2, b + 10, cx - 7, cy + 0, b + 11, 100);
      fillCylinder(model, cx - 10, cy - 1, b + 11, b + 12, 2, 100);
      break;
    }
    case "cleaner": {
      // Cap
      fillBox(model, cx - 3, cy - 3, b + 30, cx + 3, cy + 2, b + 32, c.shirt);
      // Apron
      fillBox(model, cx - 4, cy - 2, b + 10, cx + 4, cy - 2, b + 16, c.accessory);
      // Mop
      fillBox(model, cx + 6, cy - 1, b + 2, cx + 7, cy, b + 18, 90); // stick
      fillBox(model, cx + 5, cy - 2, b, cx + 8, cy + 1, b + 2, 180); // mop head
      break;
    }
    case "konsomatris": {
      // Elegant dress (replaces default)
      fillBox(model, cx - 4, cy - 2, b + 10, cx + 4, cy + 2, b + 20, c.shirt); // bodice
      // Skirt (wider at bottom)
      for (let z = b + 2; z < b + 10; z++) {
        const w = 4 + Math.floor((10 - z + b) / 2);
        fillBox(model, cx - w, cy - 2, z, cx + w, cy + 2, z + 1, c.pants);
      }
      // High heels
      fillBox(model, cx - 2, cy - 2, b, cx - 1, cy, b + 3, 40);
      fillBox(model, cx + 1, cy - 2, b, cx + 2, cy, b + 3, 40);
      // Necklace
      for (let dx = -2; dx <= 2; dx++) model.voxels.push({ x: cx + dx, y: cy - 2, z: b + 20, i: c.accent });
      // Earrings
      model.voxels.push({ x: cx - 3, y: cy - 2, z: b + 25, i: c.accent });
      model.voxels.push({ x: cx + 3, y: cy - 2, z: b + 25, i: c.accent });
      // Long hair
      fillBox(model, cx - 3, cy + 2, b + 20, cx + 3, cy + 3, b + 31, c.hair);
      break;
    }
    case "musician": {
      // Guitar/Saz
      fillSphere(model, cx - 6, cy - 1, b + 12, 3, 90); // body
      fillBox(model, cx - 6, cy - 1, b + 15, cx - 5, cy, b + 25, 80); // neck
      // Strings
      drawLine(model, cx - 6, cy - 1, b + 12, cx - 5, cy, b + 24, 250);
      break;
    }
    case "security": {
      // Sunglasses
      fillBox(model, cx - 2, cy - 3, b + 26, cx + 2, cy - 3, b + 27, 40);
      // Earpiece
      model.voxels.push({ x: cx + 3, y: cy - 1, z: b + 25, i: 40 });
      // Badge
      model.voxels.push({ x: cx - 2, y: cy - 2, z: b + 18, i: c.accessory });
      // Crossed arms pose - wider stance
      fillBox(model, cx - 6, cy - 3, b + 14, cx - 4, cy - 1, b + 18, c.shirt);
      fillBox(model, cx + 4, cy - 3, b + 14, cx + 6, cy - 1, b + 18, c.shirt);
      // Muscular build - wider torso
      fillBox(model, cx - 5, cy - 3, b + 10, cx + 5, cy + 3, b + 20, c.shirt);
      break;
    }
    case "waiter": {
      // Bow tie
      fillBox(model, cx - 1, cy - 2, b + 19, cx + 1, cy - 2, b + 20, 200);
      // Vest
      fillBox(model, cx - 3, cy - 2, b + 14, cx + 3, cy - 1, b + 18, 60);
      // Tray (held up)
      fillBox(model, cx + 5, cy - 3, b + 18, cx + 10, cy + 2, b + 19, c.accessory);
      // Glasses on tray
      fillCylinder(model, cx + 7, cy - 1, b + 19, b + 22, 1, 180);
      fillCylinder(model, cx + 7, cy + 1, b + 19, b + 22, 1, 180);
      // Napkin on arm
      fillBox(model, cx - 7, cy - 2, b + 14, cx - 5, cy, b + 16, 250);
      break;
    }
  }
}

// ===== CUSTOMER CHARACTERS =====
export type CustomerType =
  | "regular" | "worker" | "elite" | "nostalgic" | "emotional" | "young"
  | "bureaucrat" | "undercover" | "sapkali" | "gangster" | "foreign" | "vip" | "behzatc";

export function generateCustomer(
  model: VoxModelData,
  opts: { type: CustomerType; pose?: "standing" | "sitting" | "drinking"; seed?: number }
) {
  const { sizeX, sizeY, sizeZ } = model;
  const cx = Math.floor(sizeX / 2);
  const cy = Math.floor(sizeY / 2);
  const b = opts.pose === "sitting" ? 4 : 1; // sitting characters are elevated
  const rng = createRng(opts.seed ?? 0);

  // Color palettes per customer type
  const customerColors: Record<CustomerType, { skin: number; pants: number; shirt: number; accent: number; shoes: number; hair: number; accessory: number }> = {
    regular: { skin: 200, pants: 100, shirt: 120, accent: 150, shoes: 60, hair: 80, accessory: 0 },
    worker: { skin: 190, pants: 80, shirt: 90, accent: 100, shoes: 60, hair: 70, accessory: 230 }, // overalls, hard hat
    elite: { skin: 210, pants: 40, shirt: 230, accent: 250, shoes: 40, hair: 60, accessory: 250 }, // suit, gold watch
    nostalgic: { skin: 200, pants: 100, shirt: 140, accent: 120, shoes: 70, hair: 150, accessory: 100 }, // old-fashioned
    emotional: { skin: 200, pants: 80, shirt: 100, accent: 180, shoes: 60, hair: 80, accessory: 180 }, // sad, tissue
    young: { skin: 200, pants: 160, shirt: 200, accent: 230, shoes: 250, hair: 230, accessory: 230 }, // trendy, colorful
    bureaucrat: { skin: 200, pants: 100, shirt: 120, accent: 200, shoes: 40, hair: 80, accessory: 230 }, // gray suit, briefcase
    undercover: { skin: 200, pants: 80, shirt: 100, accent: 40, shoes: 40, hair: 60, accessory: 180 }, // inconspicuous, earpiece
    sapkali: { skin: 190, pants: 90, shirt: 100, accent: 80, shoes: 70, hair: 80, accessory: 90 }, // farmer hat, simple clothes
    gangster: { skin: 200, pants: 40, shirt: 60, accent: 250, shoes: 40, hair: 40, accessory: 230 }, // dark suit, gold chain
    foreign: { skin: 210, pants: 160, shirt: 180, accent: 200, shoes: 150, hair: 230, accessory: 200 }, // tourist look, camera
    vip: { skin: 210, pants: 180, shirt: 200, accent: 250, shoes: 200, hair: 250, accessory: 250 }, // flashy, expensive
    behzatc: { skin: 200, pants: 100, shirt: 80, accent: 180, shoes: 60, hair: 60, accessory: 40 }, // leather jacket, stubble
  };

  const c = customerColors[opts.type] ?? customerColors.regular;

  // === BASE HUMANOID ===
  if (opts.pose === "sitting") {
    // Sitting pose - legs bent
    fillBox(model, cx - 4, cy - 4, b, cx - 1, cy + 2, b + 2, c.pants); // left leg horizontal
    fillBox(model, cx + 1, cy - 4, b, cx + 4, cy + 2, b + 2, c.pants); // right leg horizontal
    fillBox(model, cx - 3, cy - 5, b, cx - 1, cy - 3, b + 6, c.pants); // left leg down
    fillBox(model, cx + 1, cy - 5, b, cx + 3, cy - 3, b + 6, c.pants); // right leg down
    // Feet
    fillBox(model, cx - 3, cy - 6, b - 4, cx - 1, cy - 4, b - 2, c.shoes);
    fillBox(model, cx + 1, cy - 6, b - 4, cx + 3, cy - 4, b - 2, c.shoes);
  } else {
    // Standing pose
    fillBox(model, cx - 3, cy - 1, b, cx - 1, cy + 1, b + 2, c.shoes);
    fillBox(model, cx + 1, cy - 1, b, cx + 3, cy + 1, b + 2, c.shoes);
    fillBox(model, cx - 3, cy - 1, b + 2, cx - 1, cy + 1, b + 10, c.pants);
    fillBox(model, cx + 1, cy - 1, b + 2, cx + 3, cy + 1, b + 10, c.pants);
  }

  // Torso
  fillBox(model, cx - 4, cy - 2, b + 10, cx + 4, cy + 2, b + 20, c.shirt);

  // Neck & Head
  fillBox(model, cx - 1, cy - 1, b + 20, cx + 1, cy + 1, b + 22, c.skin);
  fillBox(model, cx - 3, cy - 3, b + 22, cx + 3, cy + 3, b + 30, c.skin);

  // Hair
  fillBox(model, cx - 3, cy + 2, b + 26, cx + 3, cy + 3, b + 31, c.hair);
  fillBox(model, cx - 3, cy - 2, b + 30, cx + 3, cy + 3, b + 31, c.hair);

  // Arms
  fillBox(model, cx - 7, cy - 1, b + 12, cx - 5, cy + 1, b + 20, c.shirt);
  fillBox(model, cx + 5, cy - 1, b + 12, cx + 7, cy + 1, b + 20, c.shirt);
  fillBox(model, cx - 7, cy - 1, b + 10, cx - 5, cy + 1, b + 12, c.skin);
  fillBox(model, cx + 5, cy - 1, b + 10, cx + 7, cy + 1, b + 12, c.skin);

  // Eyes
  model.voxels.push({ x: cx - 1, y: cy - 3, z: b + 26, i: 40 });
  model.voxels.push({ x: cx + 1, y: cy - 3, z: b + 26, i: 40 });

  // === TYPE-SPECIFIC DETAILS ===
  switch (opts.type) {
    case "regular": {
      // Simple casual look, maybe a watch
      model.voxels.push({ x: cx - 6, y: cy, z: b + 11, i: 150 });
      break;
    }
    case "worker": {
      // Hard hat
      fillBox(model, cx - 4, cy - 4, b + 30, cx + 4, cy + 4, b + 32, 230);
      fillBox(model, cx - 3, cy - 3, b + 32, cx + 3, cy + 3, b + 33, 230);
      // Overalls straps
      drawLine(model, cx - 2, cy - 2, b + 20, cx - 2, cy - 2, b + 14, 100);
      drawLine(model, cx + 2, cy - 2, b + 20, cx + 2, cy - 2, b + 14, 100);
      // Dirty face marks
      model.voxels.push({ x: cx - 2, y: cy - 3, z: b + 24, i: 80 });
      break;
    }
    case "elite": {
      // Fancy suit jacket (darker overlay)
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 60);
      // Tie
      fillBox(model, cx, cy - 2, b + 14, cx, cy - 2, b + 19, c.accent);
      // Gold watch
      model.voxels.push({ x: cx - 6, y: cy, z: b + 11, i: 250 });
      // Slicked back hair
      fillBox(model, cx - 2, cy + 1, b + 28, cx + 2, cy + 3, b + 31, c.hair);
      break;
    }
    case "nostalgic": {
      // Flat cap
      fillBox(model, cx - 3, cy - 4, b + 30, cx + 3, cy + 1, b + 31, c.accessory);
      fillBox(model, cx - 2, cy - 5, b + 30, cx + 2, cy - 4, b + 31, c.accessory);
      // Cardigan/vest
      fillBox(model, cx - 3, cy - 2, b + 14, cx + 3, cy - 1, b + 18, 120);
      // Mustache
      fillBox(model, cx - 2, cy - 3, b + 23, cx + 2, cy - 3, b + 24, c.hair);
      break;
    }
    case "emotional": {
      // Sad expression - droopy eyes
      model.voxels.push({ x: cx - 1, y: cy - 3, z: b + 25, i: 180 }); // tear
      model.voxels.push({ x: cx + 1, y: cy - 3, z: b + 25, i: 180 }); // tear
      // Tissue in hand
      fillBox(model, cx + 5, cy - 2, b + 12, cx + 7, cy, b + 14, 250);
      // Messy hair
      for (let i = 0; i < 5; i++) {
        const dx = Math.floor(rng() * 6) - 3;
        const dy = Math.floor(rng() * 4) - 1;
        model.voxels.push({ x: cx + dx, y: cy + dy, z: b + 31 + Math.floor(rng() * 2), i: c.hair });
      }
      break;
    }
    case "young": {
      // Modern haircut (undercut)
      fillBox(model, cx - 3, cy - 1, b + 29, cx + 3, cy + 3, b + 33, c.hair);
      fillBox(model, cx - 3, cy + 1, b + 27, cx + 3, cy + 3, b + 29, 60); // shaved sides
      // Sneakers (colorful)
      fillBox(model, cx - 3, cy - 2, b, cx - 1, cy + 1, b + 3, c.accessory);
      fillBox(model, cx + 1, cy - 2, b, cx + 3, cy + 1, b + 3, c.accessory);
      // Phone in hand
      fillBox(model, cx + 5, cy - 2, b + 14, cx + 7, cy - 1, b + 18, 40);
      model.voxels.push({ x: cx + 6, y: cy - 2, z: b + 16, i: 180 }); // screen glow
      break;
    }
    case "bureaucrat": {
      // Gray suit
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 120);
      // Tie
      fillBox(model, cx, cy - 2, b + 14, cx, cy - 2, b + 19, 180);
      // Briefcase
      fillBox(model, cx - 8, cy - 2, b + 8, cx - 6, cy + 1, b + 14, 80);
      // Glasses
      fillBox(model, cx - 2, cy - 3, b + 26, cx + 2, cy - 3, b + 27, 180);
      model.voxels.push({ x: cx, y: cy - 3, z: b + 26, i: c.skin }); // bridge
      break;
    }
    case "undercover": {
      // Inconspicuous jacket
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 100);
      // Earpiece
      model.voxels.push({ x: cx + 3, y: cy - 1, z: b + 25, i: 40 });
      // Slight bulge (holster)
      fillBox(model, cx - 5, cy + 1, b + 14, cx - 4, cy + 2, b + 16, 80);
      // Alert eyes
      model.voxels.push({ x: cx - 1, y: cy - 3, z: b + 26, i: 60 });
      model.voxels.push({ x: cx + 1, y: cy - 3, z: b + 26, i: 60 });
      break;
    }
    case "sapkali": {
      // Farmer's flat cap / kasket
      fillBox(model, cx - 4, cy - 4, b + 30, cx + 4, cy + 2, b + 32, c.accessory);
      fillBox(model, cx - 3, cy - 6, b + 30, cx + 3, cy - 4, b + 31, c.accessory);
      // Simple rural shirt
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 110);
      // Weathered face
      model.voxels.push({ x: cx - 2, y: cy - 3, z: b + 24, i: 170 });
      model.voxels.push({ x: cx + 2, y: cy - 3, z: b + 24, i: 170 });
      // Money in pocket (from farm sale)
      model.voxels.push({ x: cx + 3, y: cy - 2, z: b + 11, i: 160 });
      break;
    }
    case "gangster": {
      // Dark suit
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 40);
      // Gold chain
      for (let dx = -2; dx <= 2; dx++) model.voxels.push({ x: cx + dx, y: cy - 2, z: b + 19, i: 250 });
      // Slicked hair
      fillBox(model, cx - 2, cy + 1, b + 28, cx + 2, cy + 3, b + 31, 40);
      // Pinky ring
      model.voxels.push({ x: cx + 6, y: cy + 1, z: b + 11, i: 250 });
      // Scar on face
      drawLine(model, cx - 2, cy - 3, b + 25, cx - 1, cy - 3, b + 27, 170);
      break;
    }
    case "foreign": {
      // Tourist outfit - Hawaiian shirt
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 180);
      // Floral pattern
      model.voxels.push({ x: cx - 2, y: cy - 2, z: b + 16, i: 200 });
      model.voxels.push({ x: cx + 2, y: cy - 2, z: b + 14, i: 230 });
      model.voxels.push({ x: cx, y: cy - 2, z: b + 18, i: 200 });
      // Camera around neck
      fillBox(model, cx - 1, cy - 3, b + 18, cx + 1, cy - 2, b + 20, 40);
      // Shorts
      fillBox(model, cx - 3, cy - 1, b + 6, cx + 3, cy + 1, b + 10, 160);
      // Sandals
      fillBox(model, cx - 3, cy - 2, b, cx - 1, cy + 1, b + 1, 90);
      fillBox(model, cx + 1, cy - 2, b, cx + 3, cy + 1, b + 1, 90);
      break;
    }
    case "vip": {
      // Expensive suit
      fillBox(model, cx - 4, cy - 2, b + 12, cx + 4, cy + 2, b + 20, 180);
      // Silk tie
      fillBox(model, cx, cy - 2, b + 14, cx, cy - 2, b + 19, 200);
      // Gold cufflinks
      model.voxels.push({ x: cx - 5, y: cy - 1, z: b + 12, i: 250 });
      model.voxels.push({ x: cx + 5, y: cy - 1, z: b + 12, i: 250 });
      // Rolex
      model.voxels.push({ x: cx - 6, y: cy, z: b + 11, i: 250 });
      // Styled hair
      fillBox(model, cx - 2, cy + 1, b + 29, cx + 2, cy + 3, b + 32, c.hair);
      // Champagne glass
      fillCylinder(model, cx + 7, cy - 1, b + 14, b + 18, 1, 180);
      break;
    }
    case "behzatc": {
      // Leather jacket
      fillBox(model, cx - 5, cy - 2, b + 12, cx + 5, cy + 2, b + 20, 80);
      // Collar up
      fillBox(model, cx - 4, cy + 2, b + 19, cx + 4, cy + 3, b + 22, 80);
      // Stubble
      fillBox(model, cx - 2, cy - 3, b + 22, cx + 2, cy - 3, b + 24, 60);
      // Cigarette
      fillBox(model, cx + 2, cy - 4, b + 23, cx + 4, cy - 4, b + 24, 250);
      model.voxels.push({ x: cx + 4, y: cy - 4, z: b + 24, i: 230 }); // ember
      // Tired eyes
      model.voxels.push({ x: cx - 1, y: cy - 3, z: b + 25, i: 120 });
      model.voxels.push({ x: cx + 1, y: cy - 3, z: b + 25, i: 120 });
      // Messy hair
      fillBox(model, cx - 3, cy - 1, b + 29, cx + 3, cy + 3, b + 32, 60);
      // Raki glass
      fillCylinder(model, cx - 7, cy - 1, b + 10, b + 14, 1, 250);
      break;
    }
  }

  // === DRINKING POSE MODIFIER ===
  if (opts.pose === "drinking") {
    // Raise right arm
    fillBox(model, cx + 5, cy - 1, b + 16, cx + 7, cy + 1, b + 24, c.shirt);
    fillBox(model, cx + 5, cy - 1, b + 24, cx + 7, cy + 1, b + 26, c.skin);
    // Glass at mouth level
    fillCylinder(model, cx + 6, cy - 2, b + 26, b + 30, 1, 180);
  }
}

export async function generateFromPrompt(model: VoxModelData, prompt: string, opts: { seed: number }) {
  const p = prompt.toLowerCase();
  if (/(ev|house|bina)/.test(p)) {
    const m = /\b(\d+)\s*kat/.exec(p);
    const floors = m ? parseInt(m[1]!, 10) : 2;
    generateHouse(model, { floors, style: /cyberpunk/.test(p) ? "cyberpunk" : "modern", seed: opts.seed });
    if (/cyberpunk/.test(p)) neonize(model);
    return;
  }
  if (/(karakter|character|humanoid|robot)/.test(p)) {
    generateCharacter(model, { style: /robot/.test(p) ? "robot" : "default", seed: opts.seed });
    if (/cyberpunk/.test(p)) neonize(model);
    return;
  }
  if (/(sphere|k.?re)/.test(p)) {
    const cx = Math.floor(model.sizeX / 2);
    const cy = Math.floor(model.sizeY / 2);
    const cz = Math.floor(model.sizeZ / 2);
    const r = Math.floor(Math.min(model.sizeX, model.sizeY, model.sizeZ) / 3);
    fillSphere(model, cx, cy, cz, r, 180);
    return;
  }
  // default: simple tower
  const cx = Math.floor(model.sizeX / 2);
  const cy = Math.floor(model.sizeY / 2);
  fillBox(model, cx - 8, cy - 8, 0, cx + 8, cy + 8, Math.floor(model.sizeZ * 0.8), 100);
}

function neonize(model: VoxModelData) {
  // Add some neon strips
  const z = clamp(Math.floor(model.sizeZ / 2), 0, model.sizeZ - 1);
  for (let x = 2; x < model.sizeX - 2; x += 4) {
    model.voxels.push({ x, y: 2, z, i: 230 });
    model.voxels.push({ x, y: model.sizeY - 3, z, i: 230 });
  }
}

export async function imageToVoxel(
  model: VoxModelData,
  imagePath: string,
  opts: { mode: "heightmap" | "extrude"; maxZ: number; threshold: number; downscale: number }
) {
  const img = await loadImage(imagePath);
  const ds = Math.max(1, opts.downscale);
  const width = Math.floor(img.width / ds);
  const height = Math.floor(img.height / ds);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, x * ds);
      const sy = Math.min(img.height - 1, y * ds);
      const idx = (sy * img.width + sx) * 4;
      const r = img.data[idx + 0] ?? 0;
      const g = img.data[idx + 1] ?? 0;
      const b = img.data[idx + 2] ?? 0;
      const a = img.data[idx + 3] ?? 255;
      const lum = Math.round(0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b));
      const vx = clamp(x, 0, model.sizeX - 1);
      const vy = clamp(y, 0, model.sizeY - 1);
      if (opts.mode === "heightmap") {
        const h = Math.floor((lum / 255) * (opts.maxZ - 1));
        for (let z = 0; z <= h && z < model.sizeZ; z++) {
          model.voxels.push({ x: vx, y: vy, z, i: Math.max(1, Math.min(255, Math.floor((lum / 255) * 255))) });
        }
      } else {
        if (lum >= opts.threshold) {
          for (let z = 0; z < Math.min(model.sizeZ, opts.maxZ); z++) {
            model.voxels.push({ x: vx, y: vy, z, i: Math.max(1, Math.min(255, Math.floor((lum / 255) * 255))) });
          }
        }
      }
    }
  }
}








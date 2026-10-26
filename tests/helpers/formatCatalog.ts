import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { defaultPalette } from '../../src/vox.js';
import { paletteToAct, paletteToPng, paletteToVox } from '../../src/paletteFormats.js';
import { encodeQB } from '../../src/formats/qb.js';
import { encodeXRAW } from '../../src/formats/xraw.js';
import { encodeSlab6 } from '../../src/formats/slab6.js';
import { encodeSchem } from '../../src/formats/schem.js';

/** Fixture files read by the format and palette tools in the catalog test. */
export function writeFormatFixtures(root: string): void {
  const model = { sizeX: 4, sizeY: 4, sizeZ: 4, palette: defaultPalette(), voxels: [{ x: 1, y: 1, z: 1, i: 20 }, { x: 2, y: 1, z: 1, i: 21 }] };
  fs.writeFileSync(path.join(root, 'palette.png'), paletteToPng(model.palette));
  fs.writeFileSync(path.join(root, 'palette.act'), paletteToAct(model.palette));
  fs.writeFileSync(path.join(root, 'palette.vox'), paletteToVox(model.palette));
  fs.writeFileSync(path.join(root, 'model.qb'), encodeQB(model));
  fs.writeFileSync(path.join(root, 'model.xraw'), encodeXRAW(model));
  fs.writeFileSync(path.join(root, 'model.slab'), encodeSlab6(model));
  fs.writeFileSync(path.join(root, 'model.schem'), encodeSchem(model));
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  fs.writeFileSync(path.join(root, 'cube.obj'), 'v 0 0 0\nv 4 0 0\nv 4 4 0\nv 0 4 0\nv 0 0 4\nv 4 0 4\nv 4 4 4\nv 0 4 4\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n');
}

const inputFor: Record<string, string> = {
  import_palette_png: 'palette.png', import_palette_act: 'palette.act', import_palette_vox: 'palette.vox',
  import_qb: 'model.qb', import_xraw: 'model.xraw', import_slab6: 'model.slab', import_minecraft_schem: 'model.schem', import_obj: 'cube.obj',
};

/** Tool-specific argument overrides for generic schema-derived examples. */
export function formatToolArgs(name: string, ctx: { id: string; other: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (inputFor[name]) out.path = inputFor[name];
  if (name === 'remap_model_to_palette') out.paletteId = ctx.other;
  if (name === 'find_nearest_color') out.color = '#ff0000';
  if (name === 'merge_palettes') out.ids = [ctx.id, ctx.other];
  return out;
}

/** Tools that create a new model which the catalog test must delete again. */
export const FORMAT_CREATING_TOOLS = new Set(['import_qb', 'import_xraw', 'import_slab6', 'import_minecraft_schem']);

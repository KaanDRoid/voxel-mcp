import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('palette, mesh and voxel format tools work end to end over stdio', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-formats-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'formats-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
      const body = (result.content as { text: string }[])[0]!.text;
      try { return JSON.parse(body); } catch { return body; }
    };
    const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
      const result = await raw(name, args);
      assert.equal(result.isError, true, `${name} should fail`);
      assert.match((result.content as { text: string }[])[0]!.text, pattern);
    };
    const read = (file: string) => fs.readFileSync(path.join(root, file));
    const make = async () => {
      const { id } = await call('create_model', { sizeX: 8, sizeY: 8, sizeZ: 8 });
      await call('fill_box', { id, x0: 2, y0: 2, z0: 2, x1: 5, y1: 5, z1: 5, i: 20 });
      return id as string;
    };
    const a = await make();
    await call('set_palette_index', { id: a, index: 20, rgba: 0xff0000ff });

    // annotations
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    assert.equal(byName.get('find_nearest_color')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('export_qb')!.annotations?.readOnlyHint, false);
    assert.equal(byName.get('import_qb')!.annotations?.destructiveHint, true);

    // palette files: export, import into another model, export again, bytes match
    const b = await make();
    for (const ext of ['png', 'act', 'vox']) {
      await call(`export_palette_${ext}`, { id: a, path: `p/a.${ext}` });
      await call(`import_palette_${ext}`, { id: b, path: `p/a.${ext}` });
      await call(`export_palette_${ext}`, { id: b, path: `p/b.${ext}` });
      assert.deepEqual(read(`p/b.${ext}`), read(`p/a.${ext}`), `${ext} round trip`);
    }
    assert.equal(read('p/a.act').length, 768);
    assert.equal(PNG.sync.read(read('p/a.png')).width, 256);
    await fails('import_palette_act', { id: b, path: 'p/a.png' }, /ACT/);

    // palette operations
    const nearest = await call('find_nearest_color', { id: a, color: '#ff0000', count: 2 });
    assert.equal(nearest.matches[0].index, 20);
    assert.equal(nearest.matches[0].deltaE, 0);
    await fails('find_nearest_color', { id: a, color: 'nonsense' }, /color/);
    const c = await make();
    await call('set_palette_index', { id: c, index: 20, rgba: 0xffff0000 });
    const remap = await call('remap_model_to_palette', { id: c, paletteId: a });
    assert.equal(remap.voxels, 64);
    await fails('remap_model_to_palette', { id: c }, /exactly one/);
    await fails('remap_model_to_palette', { id: c, paletteId: a, path: 'p/a.act' }, /exactly one/);
    const fromFile = await call('remap_model_to_palette', { id: c, path: 'p/a.png' });
    assert.ok(fromFile.maxDeltaE >= 0);
    const q = await call('quantize_model', { id: a, maxColors: 4 });
    assert.equal(q.colorsAfter, 1);
    await call('sort_palette', { id: a, by: 'lum' });
    const m = await call('merge_palettes', { ids: [a, c] });
    assert.ok(m.colors >= 1);
    await fails('merge_palettes', { ids: [a] }, /ids|too_small|least/i);

    // mesh export parameters and round trip through the MagicaVoxel profile
    const obj = await call('export_obj', { id: a, path: 'mesh/model.obj', profile: 'magica' });
    assert.equal(obj.faces, 6);
    assert.ok(fs.existsSync(path.join(root, 'mesh/model.mtl')) && fs.existsSync(path.join(root, 'mesh/model.png')));
    const back = await call('import_obj', { path: 'mesh/model.obj', scale: 0.1 });
    assert.deepEqual([back.sizeX, back.sizeY, back.sizeZ, back.voxels], [4, 4, 4, 64]);
    assert.deepEqual(back.warnings, []);
    await fails('export_obj', { id: a, path: 'mesh/bad.obj', axis: 'XXZ' }, /axis/i);
    await fails('export_obj', { id: a, path: '../outside.obj' }, /outside/i);
    await call('export_stl', { id: a, path: 'mesh/m.stl', scale: 0.5, axis: 'XYZ' });
    assert.match(read('mesh/m.stl').toString(), /^solid vox/);
    await call('export_gltf', { id: a, path: 'mesh/m.gltf', merge: true });
    assert.equal(JSON.parse(read('mesh/m.gltf').toString()).asset.version, '2.0');
    await call('export_ply', { id: a, path: 'mesh/m.ply' });

    // voxel formats round trip
    for (const [format, ext] of [['qb', 'qb'], ['xraw', 'xraw'], ['slab6', 'vox'], ['minecraft_schem', 'schem']] as const) {
      await call(`export_${format}`, { id: a, path: `fmt/model.${ext}`, ...(format === 'qb' ? { compress: true } : {}) });
      const imported = await call(`import_${format}`, { path: `fmt/model.${ext}` });
      assert.equal(imported.voxels, 64, format);
      await call('delete_model', { id: imported.id });
    }
    await call('export_minecraft_schem', { id: a, path: 'fmt/custom.schem', version: 2, blocks: [{ block: 'minecraft:stone', color: '#888888' }, { block: 'minecraft:red_wool', color: '#ff0000' }] });
    await fails('export_minecraft_schem', { id: a, path: 'fmt/bad.schem', blocks: [{ block: 'Bad Block', color: '#fff' }] }, /block/i);
    await fails('import_qb', { path: 'fmt/model.xraw' }, /QB/);

    // SVG through the tool
    fs.writeFileSync(path.join(root, 'shape.svg'), "<svg viewBox='0 0 10 10'><path d='M0 0H10V10Z' fill='#336699'/></svg>");
    const svg = await call('import_svg', { path: 'shape.svg', sizeX: 10, sizeY: 10, sizeZ: 2, thickness: 2 });
    assert.ok(svg.voxels >= 90 && svg.voxels <= 110, String(svg.voxels));
    fs.writeFileSync(path.join(root, 'bad.svg'), '<svg><text>x</text></svg>');
    await fails('import_svg', { path: 'bad.svg', sizeX: 10, sizeY: 10, sizeZ: 1 }, /unsupported SVG/);

    // GIF color reduction
    const frameModel = (await call('create_model', { sizeX: 4, sizeY: 1, sizeZ: 1 })).id as string;
    for (const [x, i] of [[0, 10], [1, 80], [2, 150], [3, 220]] as const) await call('fill_box', { id: frameModel, x0: x, y0: 0, z0: 0, x1: x, y1: 0, z1: 0, i });
    const { id: animationId } = await call('create_animation');
    await call('add_frame', { id: frameModel, animationId });
    await fails('export_animation_gif', { animationId, path: 'anim.gif', projection: 'zmax', maxColors: 2 }, /2 opaque colors/);
    const gif = await call('export_animation_gif', { animationId, path: 'anim.gif', projection: 'zmax', maxColors: 2, quantize: 'median-cut', dither: 'floyd' });
    assert.equal(gif.frames, 1);
    assert.match(gif.warnings[0], /median-cut and Floyd/);
    assert.equal(read('anim.gif').toString('ascii', 0, 6), 'GIF89a');
    const plain = await call('export_animation_gif', { animationId, path: 'anim2.gif', projection: 'zmax' });
    assert.deepEqual(plain.warnings, []);
  } finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

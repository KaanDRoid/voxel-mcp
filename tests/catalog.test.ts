import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

type Schema = { type?: string; enum?: unknown[]; const?: unknown; default?: unknown; minimum?: number; exclusiveMinimum?: number; minItems?: number; maxItems?: number; items?: Schema; prefixItems?: Schema[]; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[] };
function example(schema: Schema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return example(schema.anyOf[0]!);
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, example(schema.properties![key]!)]));
  if (schema.type === 'array') return schema.prefixItems ? schema.prefixItems.map(example) : Array.from({ length: schema.minItems ?? 1 }, () => example(schema.items ?? {}));
  if (schema.type === 'integer' || schema.type === 'number') return Math.max(1, schema.minimum ?? 0, (schema.exclusiveMinimum ?? 0) + 1);
  if (schema.type === 'boolean') return true;
  return 'test';
}

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
test('every non-scene modeling tool is exercised over stdio with real fixtures', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-catalog-'));
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 80, 20, 255], i);
  fs.writeFileSync(path.join(root, 'image.png'), PNG.sync.write(png));
  fs.writeFileSync(path.join(root, 'mesh.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  fs.writeFileSync(path.join(root, 'shape.svg'), '<svg width="16" height="16"><rect x="2" y="2" width="8" height="8" fill="#ff0000"/></svg>');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'catalog-test', version: '1.0.0' });
  const tested = new Set<string>();
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
      return result;
    };
    const parse = (r: Awaited<ReturnType<typeof call>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
    let id = parse(await call('create_model', { sizeX: 32, sizeY: 32, sizeZ: 32 })).id as string;
    const other = parse(await call('create_model', { sizeX: 32, sizeY: 32, sizeZ: 32 })).id as string;
    const fill = { x0: 4, y0: 4, z0: 4, x1: 7, y1: 7, z1: 7, i: 20 };
    await call('fill_box', { id, ...fill });
    await call('save_vox', { id, path: 'input.vox' });
    const animationId = parse(await call('create_animation')).id as string;
    await call('add_frame', { id, animationId });
    await call('add_frame', { id, animationId });
    const templateId = id;
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (tool.name.includes('scene') || ['undo', 'redo', 'batch_edit', 'delete_animation'].includes(tool.name)) continue;
      id = parse(await call('clone_model', { id: templateId })).id as string;
      const args = example(tool.inputSchema as Schema) as Record<string, unknown>;
      Object.assign(args, Object.fromEntries(Object.entries({ id, a: id, b: other, animationId, sizeX: 32, sizeY: 32, sizeZ: 32, seed: 7, scaleX: 1, scaleY: 1, scaleZ: 1, x: 8, y: 8, z: 8, cx: 8, cy: 8, cz: 8, r: 3, majorR: 4, minorR: 2, height: 4, floors: 1, i: 20, index: 0, from: 0, to: 1 }).filter(([key]) => key in (tool.inputSchema.properties ?? {}))));
      if ('voxels' in args) args.voxels = [{ x: 1, y: 1, z: 1, i: 20 }];
      if (tool.name === 'set_model_palette') args.palette = Array.from({ length: 256 }, (_, i) => i ? 0xff1450ff : 0);
      if (tool.name === 'set_palette_index') { args.index = 1; args.rgba = 0xff1450ff; }
      if (tool.name === 'boolean_op') { args.a = id; args.b = other; }
      if (tool.name === 'measure_distance') { args.a = [0, 0, 0]; args.b = [1, 1, 1]; }
      if (tool.name === 'interpolate_frames') { args.a = 0; args.b = 1; args.steps = 1; }
      if (tool.name === 'generate_from_prompt') args.prompt = 'a small house';
      if (tool.name.startsWith('export_') || tool.name.startsWith('save_')) {
        if ('path' in args) args.path = `out/${tool.name}.${tool.name.includes('gltf') ? 'gltf' : tool.name.includes('gif') ? 'gif' : tool.name.includes('png') || tool.name.includes('spritesheet') ? 'png' : tool.name.includes('minecraft') ? 'json' : tool.name.split('_').at(-1)}`;
        if ('folder' in args) args.folder = `out/${tool.name}`;
      } else if ('path' in args) args.path = tool.name === 'load_vox' || tool.name === 'open_in_magicavoxel' ? 'input.vox' : tool.name === 'import_obj' ? 'mesh.obj' : tool.name === 'import_svg' ? 'shape.svg' : 'image.png';
      for (const key of ['frontPath', 'sidePath', 'topPath']) if (key in (tool.inputSchema.properties ?? {}) && tool.name === 'multi_view_to_voxel') args[key] = 'image.png';
      if (tool.name === 'open_in_magicavoxel') {
        const result = await client.callTool({ name: tool.name, arguments: args });
        assert.equal(result.isError, true, 'unconfigured external application should fail explicitly');
      } else {
        // Each destructive operation receives the same non-empty fixture.
        if (!['create_model', 'create_animation', 'list_models'].includes(tool.name)) { await call('clear_model', { id }); await call('fill_box', { id, ...fill }); }
        const result = await call(tool.name, args);
        if ((tool.name.startsWith('generate_') && tool.name !== 'generate_tree' && tool.name !== 'generate_venue_interior' && tool.name !== 'generate_palette') || ['create_model', 'clone_model', 'scale_model', 'boolean_op', 'load_vox', 'import_obj', 'import_svg'].includes(tool.name)) {
          const createdId = parse(result).id;
          if (createdId && createdId !== id && createdId !== other) await call('delete_model', { id: createdId });
        }
        if (tool.name === 'delete_model') {
          // Deletion itself was verified; stop reusing this fixture by restoring it through undo.
          await call('undo');
        }
      }
      await call('delete_model', { id });
      tested.add(tool.name);
    }
    const expected = tools.filter(t => !t.name.includes('scene') && !['undo', 'redo', 'batch_edit', 'delete_animation'].includes(t.name)).map(t => t.name).sort();
    assert.deepEqual([...tested].sort(), expected);
    console.log(`Exercised ${tested.size} tool handlers over stdio`);
  } finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createVOXScene, saveVOXScene } from '../src/scene.js';
import { saveVOX, loadVOX } from '../src/vox.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const ints = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeInt32LE(n, i * 4)); return b; };
function chunk(id: string, content: Buffer, children: Buffer[] = []) {
  const h = Buffer.alloc(12); h.write(id); h.writeUInt32LE(content.length, 4); h.writeUInt32LE(children.reduce((n, b) => n + b.length, 0), 8);
  return Buffer.concat([h, content, ...children]);
}
const dict = (d: Record<string, string>) => Buffer.concat([ints(Object.keys(d).length), ...Object.entries(d).flatMap(([k, v]) => [k, v].map(s => Buffer.concat([ints(Buffer.byteLength(s)), Buffer.from(s)])))]);
/** Two-frame animation: one transform, one shape that lists two models. */
function animatedFile(): Buffer {
  const model = [chunk('SIZE', ints(1, 1, 1)), chunk('XYZI', Buffer.concat([ints(1), Buffer.from([0, 0, 0, 3])]))];
  const nodes = [chunk('nTRN', Buffer.concat([ints(0), dict({}), ints(1, -1, -1, 1), dict({})])), chunk('nSHP', Buffer.concat([ints(1), dict({}), ints(2, 0), dict({ _f: '0' }), ints(1), dict({ _f: '1' })]))];
  return Buffer.concat([Buffer.from('VOX '), ints(200), chunk('MAIN', Buffer.alloc(0), [...model, ...model, ...nodes])]);
}
const cube = { sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [{ x: 0, y: 0, z: 0, i: 5 }] };

function populate(root: string) {
  saveVOX(path.join(root, 'vox', 'cube.vox'), cube);
  saveVOXScene(path.join(root, 'vox', 'multi.vox'), createVOXScene([cube, cube]));
  fs.writeFileSync(path.join(root, 'vox', 'anim', 'walk.vox'), animatedFile());
  fs.writeFileSync(path.join(root, 'vox', 'broken.vox'), 'not a vox file');
  fs.writeFileSync(path.join(root, 'vox', 'notes.txt'), 'ignored');
  const png = new PNG({ width: 256, height: 1 });
  for (let slot = 0; slot < 256; slot++) png.data.set([slot, 80, 20, 255], slot * 4);
  fs.writeFileSync(path.join(root, 'palette', 'pal0.png'), PNG.sync.write(png));
}

async function withClient<T>(env: Record<string, string>, body: (client: Client, workspace: string) => Promise<T>): Promise<T> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-install-ws-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: workspace, env, stderr: 'pipe' });
  const client = new Client({ name: 'install-test', version: '1.0.0' });
  try { await client.connect(transport); return await body(client, workspace); }
  finally { await client.close(); await transport.close(); fs.rmSync(workspace, { recursive: true, force: true }); }
}
const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0]!.text;
const INSTALL_TOOLS = ['get_magicavoxel_info', 'list_magicavoxel_samples', 'list_magicavoxel_palettes', 'list_magicavoxel_shaders', 'list_magicavoxel_ibl'];

test('discovery tools report a guiding error when no installation is configured', { timeout: 30000 }, async () => {
  await withClient({}, async client => {
    for (const name of [...INSTALL_TOOLS, 'load_magicavoxel_sample']) {
      const result = await client.callTool({ name, arguments: name === 'load_magicavoxel_sample' ? { name: 'cube' } : {} });
      assert.equal(result.isError, true, name);
      assert.match(text(result), /MAGICAVOXEL_HOME/, name);
    }
    await assert.rejects(client.readResource({ uri: 'magicavoxel://install' }), /MAGICAVOXEL_HOME/);
  });
});

test('discovery tools list the installation contents and load samples by name', { timeout: 30000 }, async () => {
  const fake = makeFakeInstall();
  populate(fake.root);
  try {
    await withClient({ MAGICAVOXEL_HOME: fake.root }, async (client, workspace) => {
      const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
      const json = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); assert.ok(!r.isError, `${name}: ${text(r)}`); return JSON.parse(text(r)); };

      const tools = (await client.listTools()).tools;
      for (const name of INSTALL_TOOLS) assert.equal(tools.find(t => t.name === name)?.annotations?.readOnlyHint, true, name);
      assert.equal(tools.find(t => t.name === 'load_magicavoxel_sample')?.annotations?.readOnlyHint, false);

      const info = await json('get_magicavoxel_info');
      assert.equal(info.version, '0.99.7.2');
      assert.equal(info.os, 'win64');
      assert.equal(fs.realpathSync(info.root), fake.root);
      assert.equal(info.config.io_obj.scale, 0.1);
      assert.equal(info.counts.samples, 4);

      const samples = await json('list_magicavoxel_samples');
      const byName = Object.fromEntries(samples.map((s: { name: string }) => [s.name, s]));
      assert.deepEqual(Object.keys(byName).sort(), ['anim/walk', 'broken', 'cube', 'multi']);
      assert.equal(byName.cube.models, 1); assert.equal(byName.cube.animated, false);
      assert.equal(byName.multi.models, 2); assert.equal(byName.multi.animated, false);
      assert.equal(byName['anim/walk'].models, 2); assert.equal(byName['anim/walk'].animated, true);
      assert.equal(typeof byName.cube.sizeBytes, 'number');
      assert.equal(typeof byName.broken.error, 'string');

      const palettes = await json('list_magicavoxel_palettes');
      assert.deepEqual(palettes.map((p: { name: string }) => p.name), ['pal0']);
      assert.equal(palettes[0].width, 256); assert.equal(palettes[0].height, 1);
      assert.deepEqual((await json('list_magicavoxel_shaders')).map((s: { name: string }) => s.name), ['round']);
      assert.deepEqual((await json('list_magicavoxel_ibl')).map((s: { name: string }) => s.name), ['sky']);

      const loaded = await json('load_magicavoxel_sample', { name: 'cube' });
      assert.equal((await json('get_model_info', { id: loaded.id })).voxelCount, 1);
      assert.equal(tools.find(t => t.name === 'load_magicavoxel_palette')?.annotations?.readOnlyHint, true);
      assert.equal(tools.find(t => t.name === 'apply_magicavoxel_palette')?.annotations?.readOnlyHint, false);
      const selected = await json('load_magicavoxel_palette', { name: 'pal0' });
      assert.equal(selected.palette.length, 256);
      assert.equal(selected.palette[1], 0xff145000);
      await json('apply_magicavoxel_palette', { id: loaded.id, name: 'pal0', mode: 'recolor' });
      assert.ok(!(await call('save_vox', { id: loaded.id, path: 'recolored.vox' })).isError);
      assert.equal(loadVOX(path.join(workspace, 'recolored.vox')).palette![5], selected.palette[5]);
      await json('apply_magicavoxel_palette', { id: loaded.id, name: 'pal0', mode: 'nearest' });
      const undone = await json('undo');
      assert.equal(undone.changed, true);
      for (const bad of ['../pal0', 'pal0.png', 'missing']) {
        assert.equal((await call('load_magicavoxel_palette', { name: bad })).isError, true);
      }

      assert.equal((await call('load_magicavoxel_sample', { name: 'multi' })).isError, true);
      for (const bad of ['nope', '../config/config', 'cube.vox/../..', 'C:/x', '']) assert.equal((await call('load_magicavoxel_sample', { name: bad })).isError, true, bad);

      // the installation is readable through ordinary file parameters but never writable
      const viaPath = await json('load_vox', { path: path.join(fake.root, 'vox', 'cube.vox') });
      assert.ok(viaPath.id);
      assert.equal((await call('save_vox', { id: loaded.id, path: path.join(fake.root, 'vox', 'new.vox') })).isError, true);
      assert.equal(fs.existsSync(path.join(fake.root, 'vox', 'new.vox')), false);
      assert.equal((await call('load_vox', { path: fake.exe })).isError, true);
      assert.equal((await call('load_vox', { path: path.join(fake.root, 'cache', 'backup.vox') })).isError, true);

      // opening anything but a .vox file is rejected before any process is started
      fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
      const open = await call('open_in_magicavoxel', { path: 'a.txt' });
      assert.equal(open.isError, true);
      assert.match(text(open), /\.vox/);

      const resources = await client.listResources();
      for (const uri of ['magicavoxel://install', 'magicavoxel://samples', 'magicavoxel://palettes', 'magicavoxel://shaders', 'magicavoxel:samples', 'magicavoxel:palettes']) {
        assert.ok(resources.resources.some(r => r.uri === uri), uri);
      }
      const read = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
      assert.equal((await read('magicavoxel://install')).version, '0.99.7.2');
      assert.equal((await read('magicavoxel://samples')).length, 4);
      assert.equal((await read('magicavoxel://palettes'))[0].name, 'pal0');
      assert.equal((await read('magicavoxel://shaders'))[0].name, 'round');
      assert.ok((await read('magicavoxel:samples')).includes('cube.vox'));
      assert.deepEqual(await read('magicavoxel:palettes'), ['pal0.png']);
    });
  } finally { fake.cleanup(); }
});

test('the real installation lists its sample set when available', { skip: !process.env.MAGICAVOXEL_HOME, timeout: 60000 }, async () => {
  await withClient({ MAGICAVOXEL_HOME: process.env.MAGICAVOXEL_HOME! }, async client => {
    const json = async (name: string) => JSON.parse(text(await client.callTool({ name, arguments: {} })));
    const samples = await json('list_magicavoxel_samples');
    assert.equal(samples.length, 15);
    assert.ok(samples.every((s: { error?: string }) => !s.error));
    assert.equal(samples.filter((s: { animated: boolean }) => s.animated).length, 4);
    assert.equal((await json('list_magicavoxel_palettes')).length, 4);
    assert.equal((await json('list_magicavoxel_shaders')).length, 7);
    assert.equal((await json('list_magicavoxel_ibl')).length, 3);
    assert.equal((await json('get_magicavoxel_info')).version, '0.99.7.2');
  });
});

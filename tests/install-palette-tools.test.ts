import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { registerInstallTools, INSTALL_READ_ONLY_TOOLS } from '../src/installTools.js';
import { FilePolicy } from '../src/files.js';
import { MagicaConfig } from '../src/magicaConfig.js';
import { ModelRegistry } from '../src/model.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';

function fixture(maxInputBytes?: number) {
  const fake = makeFakeInstall();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'install-palette-ws-'));
  const server = new McpServer({ name: 'palette-test', version: '1.0.0' });
  const registry = new ModelRegistry();
  const files = new FilePolicy(workspace, maxInputBytes);
  const tools = new Map<string, { schema: z.ZodType; handler: (args: any) => Promise<CallToolResult> }>();
  const previous = process.env.MAGICAVOXEL_HOME;
  process.env.MAGICAVOXEL_HOME = fake.root;
  try {
    registerInstallTools({ server, registry, files, config: new MagicaConfig(fake.exe), register: (definition, handler) => {
      tools.set(definition.name, { schema: definition.inputSchema, handler });
    } });
  } finally {
    if (previous === undefined) delete process.env.MAGICAVOXEL_HOME;
    else process.env.MAGICAVOXEL_HOME = previous;
  }
  return {
    ...fake, workspace, registry, files,
    async call(name: string, args: Record<string, unknown>) {
      const tool = tools.get(name);
      assert.ok(tool, `Missing tool: ${name}`);
      const result = await tool.handler(tool.schema.parse(args));
      return JSON.parse((result.content[0] as { text: string }).text);
    },
    cleanup() { fake.cleanup(); fs.rmSync(workspace, { recursive: true, force: true }); }
  };
}

// Construct pixels independently of the production palette encoders.
function writePalette(root: string, name = 'Warm', pixels = 256) {
  const png = new PNG({ width: pixels, height: 1 });
  for (let slot = 0; slot < pixels; slot++) png.data.set([0, 0, 0, 255], slot * 4);
  png.data.set([255, 80, 20, 255], 0); // voxel index 1
  png.data.set([12, 34, 56, 255], 4); // voxel index 2
  if (pixels === 256) png.data.set([9, 8, 7, 6], 255 * 4); // reserved index 0
  const file = path.join(root, 'palette', `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

test('load returns an explicitly selected installed palette with voxel indexing and no registry mutation', async () => {
  const f = fixture();
  try {
    const file = writePalette(f.root);
    const bytes = fs.readFileSync(file);
    const { id, model } = f.registry.create(1, 1, 1);
    model.voxels.push({ x: 0, y: 0, z: 0, i: 2 });
    const before = structuredClone(f.registry.get(id));
    const loaded = await f.call('load_magicavoxel_palette', { name: 'warm' });
    assert.equal(loaded.name, 'Warm');
    assert.equal(loaded.palette.length, 256);
    assert.equal(loaded.palette[1], 0xff1450ff);
    assert.equal(loaded.palette[2], 0xff38220c);
    assert.equal(loaded.palette[0], 0x06070809);
    assert.deepEqual(f.registry.get(id), before);
    assert.equal(f.registry.list().length, 1);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.ok(INSTALL_READ_ONLY_TOOLS.includes('load_magicavoxel_palette'));
  } finally { f.cleanup(); }
});

test('apply requires an explicit recolor or nearest mode and supports registry undo', async () => {
  const f = fixture();
  try {
    const file = writePalette(f.root);
    const bytes = fs.readFileSync(file);
    const { id, model } = f.registry.create(2, 1, 1);
    model.voxels.push({ x: 0, y: 0, z: 0, i: 5 }, { x: 1, y: 0, z: 0, i: 6 });
    model.palette = new Uint32Array(256);
    model.palette[5] = 0xff1450ff;
    model.palette[6] = 0xff38220c;
    const before = structuredClone(model);
    await assert.rejects(f.call('apply_magicavoxel_palette', { id, name: 'Warm' }));
    const recolor = await f.registry.transaction(() => f.call('apply_magicavoxel_palette', { id, name: 'Warm', mode: 'recolor' }));
    assert.deepEqual(recolor, { id, name: 'Warm', mode: 'recolor' });
    assert.deepEqual(f.registry.get(id).voxels.map(v => v.i), [5, 6]);
    assert.equal(f.registry.get(id).palette![1], 0xff1450ff);
    assert.equal(f.registry.undo(), true);
    assert.deepEqual(f.registry.get(id), before);
    const nearest = await f.registry.transaction(() => f.call('apply_magicavoxel_palette', { id, name: 'Warm', mode: 'nearest' }));
    assert.equal(nearest.mode, 'nearest');
    assert.deepEqual(f.registry.get(id).voxels.map(v => v.i), [1, 2]);
    assert.equal(f.registry.get(id).palette![0], 0x06070809);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.ok(!INSTALL_READ_ONLY_TOOLS.includes('apply_magicavoxel_palette'));
  } finally { f.cleanup(); }
});

test('selection rejects paths, unknown names, implicit assets and extra parameters', async () => {
  const f = fixture();
  try {
    writePalette(f.root);
    const { id } = f.registry.create(1, 1, 1);
    for (const name of ['', '../Warm', 'palette/Warm', 'palette\\Warm', f.exe, 'missing', 'Warm.png', 'Warm\u0000']) {
      await assert.rejects(f.call('load_magicavoxel_palette', { name }));
      await assert.rejects(f.call('apply_magicavoxel_palette', { id, name, mode: 'nearest' }));
    }
    await assert.rejects(f.call('load_magicavoxel_palette', {}));
    await assert.rejects(f.call('load_magicavoxel_palette', { name: 'Warm', path: f.exe }));
    await assert.rejects(f.call('apply_magicavoxel_palette', { id, name: 'Warm', mode: 'automatic' }));
    await assert.rejects(f.call('apply_magicavoxel_palette', { id: 'missing', name: 'Warm', mode: 'recolor' }), /not found/);
    assert.throws(() => f.files.resolve(path.join(f.root, 'palette', 'new.png'), 'write'), /read-only/);
  } finally { f.cleanup(); }
});

test('invalid PNG input fails before changing any model', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'palette', 'broken.png'), 'not a PNG');
    writePalette(f.root, 'short', 128);
    writePalette(f.root, 'large', 512);
    const { id } = f.registry.create(1, 1, 1);
    const before = structuredClone(f.registry.get(id));
    for (const name of ['broken', 'short', 'large']) {
      await assert.rejects(f.call('load_magicavoxel_palette', { name }));
      await assert.rejects(f.call('apply_magicavoxel_palette', { id, name, mode: 'recolor' }));
      assert.deepEqual(f.registry.get(id), before);
    }
  } finally { f.cleanup(); }
});

test('installed palettes obey the configured FilePolicy byte limit', async () => {
  const f = fixture(16);
  try {
    writePalette(f.root);
    await assert.rejects(f.call('load_magicavoxel_palette', { name: 'Warm' }), /size limit/);
  } finally { f.cleanup(); }
});

test('a palette directory replaced by an escaping junction is rejected by FilePolicy', async () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-outside-'));
  try {
    fs.mkdirSync(path.join(outside, 'palette'));
    writePalette(outside);
    fs.rmSync(path.join(f.root, 'palette'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'palette'), path.join(f.root, 'palette'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.call('load_magicavoxel_palette', { name: 'Warm' }), /outside/);
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('nearest uses default source colors, never chooses index zero and breaks RGB ties by lowest index', async () => {
  const f = fixture();
  try {
    const png = new PNG({ width: 256, height: 1 });
    for (let slot = 0; slot < 256; slot++) png.data.set([255, 255, 255, slot === 0 ? 0 : 255], slot * 4);
    fs.writeFileSync(path.join(f.root, 'palette', 'ties.png'), PNG.sync.write(png));
    const { id, model } = f.registry.create(1, 1, 1);
    model.voxels.push({ x: 0, y: 0, z: 0, i: 42 });
    await f.call('apply_magicavoxel_palette', { id, name: 'ties', mode: 'nearest' });
    assert.equal(f.registry.get(id).voxels[0]!.i, 1);
    assert.equal(f.registry.get(id).palette![1], 0x00ffffff);
  } finally { f.cleanup(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { decodeVOXScene } from '../src/scene.js';

const ints = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeInt32LE(n, i * 4)); return b; };
function chunk(id: string, content: Buffer, children: Buffer[] = []) {
  const h = Buffer.alloc(12); h.write(id); h.writeUInt32LE(content.length, 4); h.writeUInt32LE(children.reduce((n, b) => n + b.length, 0), 8);
  return Buffer.concat([h, content, ...children]);
}
function dict(d: Record<string, string>) {
  const parts = [ints(Object.keys(d).length)];
  for (const [k, v] of Object.entries(d)) for (const s of [k, v]) { const b = Buffer.from(s); parts.push(ints(b.length), b); }
  return Buffer.concat(parts);
}
/** Shaped like files written by the desktop application: 256 MATL chunks with ids 1..256. */
function realisticFixture(): Buffer {
  const matl = Array.from({ length: 256 }, (_, i) => chunk('MATL', Buffer.concat([ints(i + 1), dict({ _type: '_diffuse', _weight: '1', _rough: '0.1', _spec: '0.5', _ior: '0.3', _ri: '1.3', _d: '0.05', _g: '-1', _metal: '0' })])));
  const rgba = Buffer.alloc(1024); for (let i = 0; i < 255; i++) rgba.writeUInt32LE(0xff000000 + i * 1000, i * 4);
  const children = [chunk('SIZE', ints(2, 2, 2)), chunk('XYZI', Buffer.concat([ints(1), Buffer.from([0, 0, 0, 5])])), chunk('RGBA', rgba), ...matl];
  return Buffer.concat([Buffer.from('VOX '), ints(200), chunk('MAIN', Buffer.alloc(0), children)]);
}

test('set_scene_material accepts ids 1..256 and leaves every other chunk untouched', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-matl-'));
  const source = realisticFixture();
  fs.writeFileSync(path.join(root, 'real.vox'), source);
  assert.equal(decodeVOXScene(source).materials.length, 256);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'matl-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const text = (r: Awaited<ReturnType<typeof call>>) => (r.content as { text: string }[])[0]!.text;
    const loaded = await call('load_scene', { path: 'real.vox' });
    assert.ok(!loaded.isError, text(loaded));
    const { sceneId } = JSON.parse(text(loaded));
    const ok = await call('set_scene_material', { sceneId, index: 256, properties: { _rough: '0.9' } });
    assert.ok(!ok.isError, text(ok));
    for (const index of [0, 257]) assert.equal((await call('set_scene_material', { sceneId, index, properties: { _rough: '0.9' } })).isError, true);
    const saved = await call('save_scene', { sceneId, path: 'out.vox' });
    assert.ok(!saved.isError, text(saved));
    const before = decodeVOXScene(source), after = decodeVOXScene(fs.readFileSync(path.join(root, 'out.vox')));
    assert.equal(after.materials.length, 256);
    assert.equal(after.materials.find(m => m.id === 256)!.attributes._rough, '0.9');
    assert.equal(after.materials.find(m => m.id === 256)!.attributes._metal, '0');
    const raw = (s: ReturnType<typeof decodeVOXScene>, id: number) => s.document.main.children.filter(c => c.id === 'MATL' && c.content.readInt32LE(0) === id).map(c => c.content.toString('hex'));
    for (let id = 1; id <= 255; id++) assert.deepEqual(raw(after, id), raw(before, id), `MATL ${id} changed`);
    assert.notDeepEqual(raw(after, 256), raw(before, 256));
    for (const kind of ['SIZE', 'XYZI', 'RGBA']) assert.deepEqual(after.document.main.children.filter(c => c.id === kind).map(c => c.content.toString('hex')), before.document.main.children.filter(c => c.id === kind).map(c => c.content.toString('hex')));
  } finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('stdio discovery, model editing, resources and prompts work through a real client', { timeout: 20000 }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'magicvoxel-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: workspace, stderr: 'pipe' });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'create_model'));
    assert.equal(new Set(tools.tools.map(t => t.name)).size, tools.tools.length);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result;
    };
    const created = await call('create_model', { sizeX: 8, sizeY: 8, sizeZ: 8 });
    const id = JSON.parse((created.content as { type: string; text: string }[])[0]!.text).id;
    await call('fill_box', { id, x0: 1, y0: 1, z0: 1, x1: 2, y1: 2, z1: 2, i: 3 });
    await call('save_vox', { id, path: 'out/example.vox' });
    assert.equal(readFileSync(path.join(workspace, 'out/example.vox')).subarray(0, 4).toString(), 'VOX ');
    const loaded = await call('load_vox', { path: 'out/example.vox' });
    const loadedId = JSON.parse((loaded.content as { text: string }[])[0]!.text).id;
    const info = await call('get_model_info', { id: loadedId });
    assert.equal(JSON.parse((info.content as { text: string }[])[0]!.text).voxelCount, 8);
    await call('clear_model', { id: loadedId });
    await call('undo');
    const restored = await call('get_model_info', { id: loadedId });
    assert.equal(JSON.parse((restored.content as { text: string }[])[0]!.text).voxelCount, 8);
    await call('redo');
    const cleared = await call('get_model_info', { id: loadedId });
    assert.equal(JSON.parse((cleared.content as { text: string }[])[0]!.text).voxelCount, 0);
    await call('undo');
    const resources = await client.listResources();
    assert.ok(resources.resources.some(r => r.uri === 'magicavoxel:models'));
    const models = await client.readResource({ uri: 'magicavoxel:models' });
    assert.ok(models.contents.length);
    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.some(p => p.name === 'make_house'));
    const before = await call('list_models');
    const prompt = await client.getPrompt({ name: 'make_house', arguments: { size: '32', floors: '2' } });
    assert.equal(prompt.messages[0]!.role, 'user');
    assert.equal(prompt.messages[0]!.content.type, 'text');
    const after = await call('list_models');
    assert.deepEqual(after.content, before.content, 'fetching a prompt must not mutate models');
    const traversal = await client.callTool({ name: 'save_vox', arguments: { id, path: '../escape.vox' } });
    assert.equal(traversal.isError, true, 'workspace traversal must be rejected');
    const oversized = await client.callTool({ name: 'create_model', arguments: { sizeX: 257, sizeY: 8, sizeZ: 8 } });
    assert.equal(oversized.isError, true);
    const preview = await call('render_model', { id, projection: 'isometric' });
    const image = (preview.content as { type: string; data: string; mimeType: string }[]).find(c => c.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(Buffer.from(image!.data, 'base64').subarray(1, 4).toString(), 'PNG');
  } finally {
    await client.close();
    await transport.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

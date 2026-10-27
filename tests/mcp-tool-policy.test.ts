import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { KNOWN_TOOL_NAMES, resolveToolPolicy, shouldRegisterTool, selectedToolsets } from '../src/toolPolicy.js';

async function withClient(groups: string | undefined, run: (client: Client) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-policy-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], cwd: root, env: { MAGICVOXEL_MCP_TOOLSETS: groups ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'tool-policy-test', version: '1.0.0' });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
test('every registered tool advertises its effect policy and JSON results include structured content', async () => {
  await withClient(undefined, async client => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), [...KNOWN_TOOL_NAMES].sort());
    for (const tool of tools) {
      const policy = resolveToolPolicy(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, policy.readOnly, tool.name);
      assert.equal(tool._meta?.['magicvoxel/toolset'], policy.toolset, tool.name);
      assert.deepEqual(tool._meta?.['magicvoxel/effects'], policy.effects, tool.name);
    }
    const result = await client.callTool({ name: 'create_model', arguments: { sizeX: 2, sizeY: 2, sizeZ: 2 } });
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent, JSON.parse((result.content[0] as { text: string }).text));
    const listed = await client.callTool({ name: 'list_models', arguments: {} });
    assert.deepEqual(listed.structuredContent, { items: JSON.parse((listed.content[0] as { text: string }).text) });
    const bad = await client.callTool({ name: 'get_model_info', arguments: { id: 'missing' } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent, undefined);
  });
});
test('an explicit toolset limits callable tools and retains core dependencies', async () => {
  await withClient('scene,palette', async client => {
    const tools = (await client.listTools()).tools;
    const selection = selectedToolsets({ MAGICVOXEL_MCP_TOOLSETS: 'scene,palette' });
    assert.deepEqual(tools.map(t => t.name).sort(), [...KNOWN_TOOL_NAMES].filter(n => shouldRegisterTool(n, selection)).sort());
    assert.ok(tools.some(t => t.name === 'create_model'));
    assert.ok(tools.some(t => t.name === 'create_scene'));
    assert.ok(!tools.some(t => t.name === 'run_xs_shader'));
    assert.ok(!tools.some(t => t.name === 'attach_magicavoxel_app'));
    await assert.rejects(client.callTool({ name: 'run_xs_shader', arguments: { id: 'missing', source: 'invalid' } }), /not found/);
    const created = await client.callTool({ name: 'create_model', arguments: { sizeX: 2, sizeY: 2, sizeZ: 2 } });
    assert.ok(!created.isError);
    const { id } = JSON.parse((created.content[0] as { text: string }).text);
    const scene = await client.callTool({ name: 'create_scene', arguments: { modelIds: [id] } });
    assert.ok(!scene.isError);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeFakeInstall } from './helpers/fakeInstall.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
test('an installation stays read-only even when the workspace contains the installation', { timeout: 20000 }, async () => {
  const install = makeFakeInstall();
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: install.root,
    env: { ...process.env as Record<string, string>, MAGICAVOXEL_HOME: install.root, MAGICAVOXEL_PATH: install.exe, MAGICVOXEL_MCP_WORKSPACE: install.root }, stderr: 'pipe' });
  const client = new Client({ name: 'install-safety-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const model = await client.callTool({ name: 'create_model', arguments: { sizeX: 4, sizeY: 4, sizeZ: 4 } });
    assert.ok(!model.isError);
    const { id } = JSON.parse((model.content as { text: string }[])[0]!.text);
    const target = path.join(install.root, 'vox', 'blocked.vox');
    const result = await client.callTool({ name: 'save_vox', arguments: { id, path: target } });
    assert.equal(result.isError, true, 'save_vox must not write to the application installation');
    assert.equal(fs.existsSync(target), false);
    const code = await client.callTool({ name: 'import_svg', arguments: { path: install.exe, sizeX: 4, sizeY: 4, sizeZ: 4 } });
    assert.equal(code.isError, true);
    const read = await client.callTool({ name: 'get_magicavoxel_info', arguments: {} });
    assert.ok(!read.isError, JSON.stringify(read));
  } finally { await client.close(); await transport.close(); install.cleanup(); }
});

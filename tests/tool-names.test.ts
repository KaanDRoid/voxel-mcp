import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const snapshotFile = fileURLToPath(new URL('./snapshots/tool-names.json', import.meta.url));

// Set UPDATE_SNAPSHOT=1 to rewrite the snapshot after adding or removing a tool on purpose.
test('the advertised tool names match the committed snapshot', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-names-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'names-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
    if (process.env.UPDATE_SNAPSHOT === '1') fs.writeFileSync(snapshotFile, JSON.stringify(names, null, 2) + '\n');
    const expected = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as string[];
    assert.deepEqual(names, expected, 'tool list changed; review it and rerun with UPDATE_SNAPSHOT=1');
  } finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

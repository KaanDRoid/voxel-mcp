import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const shader = '// xs_begin\n// xs_end\nfloat map(vec3 v) { float n = v.x; for (int j = 0; j < 4000; j++) { n = sin(n) + 0.4; } return n; }';
test('long shader evaluation keeps the protocol responsive and rolls back on timeout', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-responsive-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'responsive-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const created = await client.callTool({ name: 'create_model', arguments: { sizeX: 64, sizeY: 64, sizeZ: 64 } });
    const { id } = JSON.parse((created.content as { text: string }[])[0]!.text);
    const padded = '// ' + 'x'.repeat(5000) + '\n// xs_begin\n// xs_end\nfloat map(vec3 v) { return 1.0; }';
    const validated = await client.callTool({ name: 'validate_xs_shader', arguments: { source: padded } });
    assert.ok(!validated.isError, 'inline shader sources within 64 KiB must not hit the generic string cap');
    const pending = client.callTool({ name: 'run_xs_shader', arguments: { id, source: shader, timeLimitMs: 2000 } });
    await new Promise(resolve => setTimeout(resolve, 200));
    const started = performance.now();
    await client.ping();
    assert.ok(performance.now() - started < 1000, 'ping should not wait for synchronous shader execution');
    const result = await pending;
    assert.equal(result.isError, true);
    const info = await client.callTool({ name: 'get_model_info', arguments: { id } });
    assert.equal(JSON.parse((info.content as { text: string }[])[0]!.text).voxelCount, 0);
  } finally { await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

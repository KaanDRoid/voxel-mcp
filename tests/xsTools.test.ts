import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const SPHERE = `// xs_begin
// author : 'test'
// arg : { var = 'm_scale' name = 'Scale' value = '1' range = '0.1 1' step = '0.1' precision = '1' }
// xs_end
float map( vec3 v ) {
  vec3 h = i_volume_size * 0.5;
  return i_color_index * step( length( ( v - h ) / h ), m_scale );
}
`;

test('xs shader tools work end to end over stdio, including undo and install-folder protection', { timeout: 120000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-xs-')));
  const install = path.join(base, 'install');
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(install, 'shader'), { recursive: true });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(install, 'shader', 'ball.txt'), SPHERE);
  fs.writeFileSync(path.join(install, 'shader', 'readme.txt'), 'not a shader');
  fs.writeFileSync(path.join(work, 'mine.txt'), SPHERE.replace("'test'", "'local'"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: work, env: { ...process.env as Record<string, string>, MAGICVOXEL_MCP_WORKSPACE: work, MAGICAVOXEL_HOME: install }, stderr: 'pipe' });
  const client = new Client({ name: 'xs-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const ok = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await raw(name, args);
      assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    const fails = async (name: string, args: Record<string, unknown>, re: RegExp) => {
      const r = await raw(name, args);
      assert.equal(r.isError, true, `${name} should fail`);
      assert.match((r.content as { text: string }[])[0]!.text, re);
    };

    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map(t => [t.name, t]));
    for (const n of ['list_xs_shaders', 'read_xs_shader', 'validate_xs_shader', 'generate_xs_shader_template']) assert.equal(byName.get(n)?.annotations?.readOnlyHint, true, n);
    for (const n of ['write_xs_shader', 'run_xs_shader']) assert.equal(byName.get(n)?.annotations?.readOnlyHint, false, n);

    const list = await ok('list_xs_shaders');
    assert.deepEqual(list.shaders.map((s: { name: string; location: string }) => `${s.location}:${s.name}`), ['workspace:mine', 'install:ball']);
    assert.equal((await ok('list_xs_shaders', { location: 'install' })).count, 1);
    await fails('list_xs_shaders', { subdir: '../elsewhere' }, /workspace/);

    const read = await ok('read_xs_shader', { name: 'ball' });
    assert.equal(read.source, SPHERE);
    assert.equal(read.header.args[0].var, 'm_scale');
    assert.equal((await ok('read_xs_shader', { path: 'mine.txt' })).header.author, 'local');
    await fails('read_xs_shader', { name: '../work/mine' }, /name/i);
    await fails('read_xs_shader', { path: '../install/shader/ball.txt' }, /workspace/);
    await fails('read_xs_shader', {}, /exactly one/);
    await fails('read_xs_shader', { name: 'ball', path: 'mine.txt' }, /exactly one/);

    const valid = await ok('validate_xs_shader', { source: SPHERE });
    assert.equal(valid.valid, true);
    assert.equal(valid.evaluable, true);
    const invalid = await ok('validate_xs_shader', { source: '// xs_begin\n' });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.length >= 2);

    const tpl = await ok('generate_xs_shader_template', { kind: 'torus' });
    assert.equal((await ok('validate_xs_shader', { source: tpl.source })).valid, true);

    await ok('write_xs_shader', { path: 'out/torus.txt', source: tpl.source });
    assert.equal(fs.readFileSync(path.join(work, 'out', 'torus.txt'), 'utf8'), tpl.source);
    await fails('write_xs_shader', { path: 'out/torus.txt', source: tpl.source }, /already exists/);
    await ok('write_xs_shader', { path: 'out/torus.txt', source: tpl.source, overwrite: true });
    await fails('write_xs_shader', { path: 'out/bad.txt', source: 'float map( vec3 v ) { return 1.0; }' }, /not valid/);
    assert.equal(fs.existsSync(path.join(work, 'out', 'bad.txt')), false);
    await fails('write_xs_shader', { path: 'out/shader.vox', source: tpl.source }, /\.txt/);
    await fails('write_xs_shader', { path: '../install/shader/evil.txt', source: tpl.source }, /workspace/);
    assert.equal(fs.existsSync(path.join(install, 'shader', 'evil.txt')), false);

    const { id } = await ok('create_model', { sizeX: 15, sizeY: 15, sizeZ: 15 });
    const count = async () => (await ok('count_colors', { id })) as unknown;
    const before = JSON.stringify(await count());
    const run = await ok('run_xs_shader', { id, name: 'ball', colorIndex: 7 });
    assert.ok(run.voxels > 1000);
    const after = await ok('count_colors', { id });
    assert.notEqual(JSON.stringify(after), before);
    // Independent count of voxel centers within radius 7.5 of the center of a 15 cube
    let expected = 0;
    for (let x = 0; x < 15; x++) for (let y = 0; y < 15; y++) for (let z = 0; z < 15; z++) if ((x - 7) ** 2 + (y - 7) ** 2 + (z - 7) ** 2 <= 56.25) expected++;
    assert.equal(run.voxels, expected);

    const half = await ok('run_xs_shader', { id, path: 'mine.txt', args: { m_scale: 0.5 }, colorIndex: 3 });
    assert.ok(half.voxels < run.voxels);
    await ok('undo');
    assert.equal(JSON.stringify(await ok('count_colors', { id })), JSON.stringify(after));
    await ok('undo');
    assert.equal(JSON.stringify(await ok('count_colors', { id })), before);

    await fails('run_xs_shader', { id, name: 'ball', args: { m_scale: 5 } }, /within/);
    await fails('run_xs_shader', { id, name: 'ball', args: { nope: 1 } }, /Unknown shader arg/);
    await fails('run_xs_shader', { id: 'missing', name: 'ball' }, /not found|Unknown|missing/i);
    await fails('run_xs_shader', { id, source: 'float map( vec3 v ) { while ( true ) { } return 1.0; }'.replace('float', '// xs_begin\n// xs_end\nfloat') }, /loop iteration limit/);
    assert.equal(JSON.stringify(await ok('count_colors', { id })), before, 'failed run leaves the model untouched');
    await fails('run_xs_shader', { id, source: SPHERE, extra: 1 }, /extra|Unrecognized|unknown/i);
  } finally { await client.close(); await transport.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('write_xs_shader refuses to write into the MagicaVoxel shader folder even when it is inside the workspace', { timeout: 60000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-xs2-')));
  fs.mkdirSync(path.join(base, 'shader'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: base, env: { ...process.env as Record<string, string>, MAGICVOXEL_MCP_WORKSPACE: base, MAGICAVOXEL_HOME: base }, stderr: 'pipe' });
  const client = new Client({ name: 'xs-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tpl = JSON.parse(((await client.callTool({ name: 'generate_xs_shader_template', arguments: { kind: 'gradient' } })).content as { text: string }[])[0]!.text);
    const r = await client.callTool({ name: 'write_xs_shader', arguments: { path: 'shader/new.txt', source: tpl.source } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0]!.text, /MagicaVoxel shader folder/);
    assert.equal(fs.existsSync(path.join(base, 'shader', 'new.txt')), false);
    const ok = await client.callTool({ name: 'write_xs_shader', arguments: { path: 'mine.txt', source: tpl.source } });
    assert.ok(!ok.isError);
  } finally { await client.close(); await transport.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

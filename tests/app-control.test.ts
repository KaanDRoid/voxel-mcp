import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { MagicaConfig } from '../src/magicaConfig.js';
import { FilePolicy } from '../src/files.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CALIBRATED_VERSION, UI_AUTOMATION_ENV, UI_ANY_VERSION_ENV, UI_SCRIPT, cameraCommands, checkTypablePath, makeRunner, photoSizeCommands, registerAppControlTools, runPowerShell, type AppControlDeps } from '../src/appControl.js';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeFakeInstall } from './helpers/fakeInstall.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type Handler = (args: never) => Promise<CallToolResult>;

function setup(t: TestContext, deps: AppControlDeps = {}) {
  let clock = 0;
  const install = makeFakeInstall();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-control-ws-')));
  t.after(() => { install.cleanup(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler }>();
  registerAppControlTools((definition, handler) => { tools.set(definition.name, { schema: definition.inputSchema, handler }); }, new FilePolicy(workspace), new MagicaConfig(install.exe), { platform: 'win32', env: { [UI_AUTOMATION_ENV]: '1' }, sleep: async ms => { clock += ms; }, now: () => clock, settleSeconds: 0, ...deps });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is registered`);
    try {
      const result = await tool.handler(tool.schema.parse(args) as never);
      const content = result.content[0];
      assert.ok(content?.type === 'text');
      return { ok: true as const, value: JSON.parse(content.text) as Record<string, unknown> };
    } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  };
  return { install, tools, call, workspace };
}

const process1 = (exe: string, pid = 4242) => ({ pid, exe, startFileTime: '134000000000000000' });

test('live animation timing requires attachment, propagates helper refusal and reports only submission', async t => {
  let fail=false;
  const h=setup(t,{run:async (_script,input)=>{
    if((input as {mode:string}).mode==='list')return {ok:true,processes:[process1(h.install.exe,77)]};
    return fail?{ok:false,error:'Probe helper refusal'}:{ok:true,steps:['console']};
  }});
  assert.match(((await h.call('set_app_animation_timing',{speed:25})) as {error:string}).error,/No application is attached/);
  await h.call('attach_magicavoxel_app');
  const result=await h.call('set_app_animation_timing',{start:2,end:3,speed:25});
  assert.ok(result.ok);assert.equal(result.value.applied,'not confirmed by the application');
  assert.deepEqual(result.value.submitted,['set a_min 0','set a_max 3','set a_min 2','set a_speed 25']);
  fail=true;const refused=await h.call('set_app_animation_timing',{speed:25});
  assert.equal(refused.ok,false);assert.match((refused as {error:string}).error,/Probe helper refusal/);
});

test('camera commands are built from numbers only, in a fixed order, within limits', () => {
  assert.deepEqual(cameraCommands({ rz: 5, ry: 30, x: 1.23456789, fov: 40 }), ['cam x 1.2346', 'cam fov 40', 'cam ry 30', 'cam rz 5']);
  assert.throws(() => cameraCommands({}), /at least one/);
  assert.deepEqual(cameraCommands({ ry: 10 }, { focus: true }), ['cam focus', 'cam ry 10']);
  assert.deepEqual(cameraCommands({}, { focus: true }), ['cam focus']);
  assert.throws(() => cameraCommands({ ry: 400 }), /ry must be between/);
  assert.throws(() => cameraCommands({ fov: Number.NaN }), /fov must be between/);
  assert.throws(() => cameraCommands({ zoom: 0 }), /zoom must be between/);
});

test('photo size commands accept 1..12000 integers only', () => {
  assert.deepEqual(photoSizeCommands(1280, 960), ['set pt_photo_w 1280', 'set pt_photo_h 960']);
  for (const bad of [0, 12001, 1.5, -3]) assert.throws(() => photoSizeCommands(bad, 100), /width must be/);
  assert.throws(() => photoSizeCommands(100, 12001), /height must be/);
});

test('without the opt-in variable or off Windows every tool refuses to touch the desktop', async t => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true }; };
  const off = setup(t, { env: {}, run });
  for (const [name, args] of [['attach_magicavoxel_app', {}], ['set_app_camera', { ry: 1 }], ['set_app_animation_timing', { speed: 1 }], ['export_native_render', { path: path.join(off.install.root, 'a.png') }]] as const) {
    const result = await off.call(name, args);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /MAGICVOXEL_MCP_UI_AUTOMATION=1/);
  }
  const linux = setup(t, { platform: 'linux', run });
  assert.match(((await linux.call('set_app_camera', { ry: 1 })) as { error: string }).error, /only available on Windows/);
  assert.equal(calls, 0);
});

test('attach pins only a process whose executable is the configured one', async t => {
  const h = setup(t, { run: async (_script, input) => {
    assert.deepEqual(input, { mode: 'list' });
    return { ok: true, processes: [process1('C:\\Elsewhere\\MagicaVoxel.exe', 11), process1(h.install.exe, 22)] };
  } });
  const attached = await h.call('attach_magicavoxel_app');
  assert.ok(attached.ok);
  assert.equal(attached.value.pid, 22);

  const none = setup(t, { run: async () => ({ ok: true, processes: [process1('C:\\Elsewhere\\MagicaVoxel.exe', 11)] }) });
  assert.match(((await none.call('attach_magicavoxel_app')) as { error: string }).error, /No running MagicaVoxel process uses the configured executable/);

  const many = setup(t, { run: async () => ({ ok: true, processes: [process1(many.install.exe, 1), process1(many.install.exe, 2)] }) });
  assert.match(((await many.call('attach_magicavoxel_app')) as { error: string }).error, /Several instances are running \(pids 1, 2\)/);
  assert.ok((await many.call('attach_magicavoxel_app', { pid: 2 })).ok);
  assert.match(((await many.call('attach_magicavoxel_app', { pid: 3 })) as { error: string }).error, /not a MagicaVoxel instance/);
});

test('camera control requires an attached process and sends the pinned identity with typed console steps', async t => {
  const seen: unknown[] = [];
  const h = setup(t, { run: async (script, input) => {
    if ((input as { mode: string }).mode === 'list') return { ok: true, processes: [process1(h.install.exe, 77)] };
    assert.equal(script, UI_SCRIPT);
    seen.push(input);
    return { ok: true, steps: ['console'] };
  } });
  assert.match(((await h.call('set_app_camera', { ry: 10 })) as { error: string }).error, /No application is attached/);
  await h.call('attach_magicavoxel_app');
  const result = await h.call('set_app_camera', { ry: 45, zoom: 2 });
  assert.ok(result.ok);
  assert.deepEqual(result.value.submitted, ['cam zoom 2', 'cam ry 45']);
  assert.equal(result.value.applied, 'not confirmed by the application');
  const sent = seen[0] as { pid: number; exe: string; startFileTime: string; steps: { op: string; text: string }[] };
  assert.equal(sent.pid, 77);
  assert.equal(sent.startFileTime, '134000000000000000');
  assert.deepEqual(sent.steps.map(s => [s.op, s.text]), [['console', 'cam zoom 2'], ['console', 'cam ry 45']]);
  assert.equal((await h.call('set_app_camera', {})).ok, false);
  assert.equal((await h.call('set_app_camera', { ry: 9999 })).ok, false);
  assert.equal(((await h.call('set_app_camera', { bogus: 1 })) as { ok: boolean }).ok, false);
});

test('a refused or failed helper run is reported as an error, never as success', async t => {
  const h = setup(t, { run: async (_s, input) => (input as { mode: string }).mode === 'list' ? { ok: true, processes: [process1(h.install.exe)] } : { ok: false, error: 'Foreground focus could not be given to the pinned MagicaVoxel process; no input was sent' } });
  await h.call('attach_magicavoxel_app');
  assert.match(((await h.call('set_app_camera', { rx: 1 })) as { error: string }).error, /no input was sent/);
});

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([(i / 4) % 256, 80, 20, 255], i);
  return PNG.sync.write(image);
}

async function renderFixture(t: TestContext, produce: (file: string) => void) {
  let out = '';
  const steps: { op: string; text?: string; path?: string }[][] = [];
  const h = setup(t, { run: async (_s, input) => {
    const message = input as { mode: string; steps?: { op: string; text?: string; path?: string }[] };
    if (message.mode === 'list') return { ok: true, processes: [process1(h.install.exe)] };
    steps.push(message.steps!);
    produce(out);
    return { ok: true, steps: message.steps!.map(s => s.op) };
  } });
  out = path.join(h.workspace, 'night.png');
  await h.call('attach_magicavoxel_app');
  return { h, out, steps };
}

test('a native render is reported only after the finished PNG has the requested size', { skip: process.platform !== 'win32' }, async t => {
  const f = await renderFixture(t, file => fs.writeFileSync(file, png(64, 48)));
  const result = await f.h.call('export_native_render', { path: f.out, imageWidth: 64, imageHeight: 48, timeoutSeconds: 30 });
  assert.ok(result.ok, 'error' in result ? result.error : 'ok');
  const verified = result.value.verified as { fileStableSeconds: number };
  assert.ok(Number.isInteger(verified.fileStableSeconds) && verified.fileStableSeconds >= 0);
  assert.deepEqual({ ...verified, fileStableSeconds: 0 }, { fileStableSeconds: 0, regularFileInsideWorkspace: true, writtenByThisRun: true, pngStructureAndChecksums: true, dimensions: true });
  assert.deepEqual(f.steps[0]!.map(s => s.op), ['console', 'console', 'image_tab', 'image_mode', 'render_button', 'save_dialog']);
  assert.deepEqual(f.steps[0]!.slice(0, 2).map(s => s.text), ['set pt_photo_w 64', 'set pt_photo_h 48']);
  assert.equal(f.steps[0]!.at(-1)!.path, f.out.replace(/\//g, '\\'));
});

test('a wrong-sized, truncated or corrupt render is an error', { skip: process.platform !== 'win32' }, async t => {
  const wrong = await renderFixture(t, file => fs.writeFileSync(file, png(10, 10)));
  assert.match(((await wrong.h.call('export_native_render', { path: wrong.out, imageWidth: 64, imageHeight: 48, timeoutSeconds: 30 })) as { error: string }).error, /10x10, not the requested 64x48/);

  const cut = await renderFixture(t, file => fs.writeFileSync(file, png(64, 48).subarray(0, 200)));
  assert.equal((await cut.h.call('export_native_render', { path: cut.out, imageWidth: 64, imageHeight: 48, timeoutSeconds: 30 })).ok, false);

  const corrupt = await renderFixture(t, file => { const bytes = png(64, 48); bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff; fs.writeFileSync(file, bytes); });
  assert.match(((await corrupt.h.call('export_native_render', { path: corrupt.out, imageWidth: 64, imageHeight: 48, timeoutSeconds: 30 })) as { error: string }).error, /bad checksum|PNG/);
});

test('rendering refuses existing files, other extensions and absent output', { skip: process.platform !== 'win32' }, async t => {
  const f = await renderFixture(t, () => {});
  fs.writeFileSync(f.out, 'old');
  assert.match(((await f.h.call('export_native_render', { path: f.out, imageWidth: 8, imageHeight: 8 })) as { error: string }).error, /already exists/);
  assert.match(((await f.h.call('export_native_render', { path: f.out.replace('.png', '.jpg'), imageWidth: 8, imageHeight: 8 })) as { error: string }).error, /\.png/);
  fs.rmSync(f.out);
  assert.match(((await f.h.call('export_native_render', { path: f.out, imageWidth: 8, imageHeight: 8, timeoutSeconds: 30 }) ) as { error: string }).error, /did not finish within 30 seconds/);
  assert.equal(f.steps.length, 1, 'only the absent-output run reached the helper');
});

test('the Windows helper script compiles and lists processes without touching any window', { skip: process.platform !== 'win32' }, async () => {
  const result = await runPowerShell(UI_SCRIPT, { mode: 'list' }, 60000) as { ok: boolean; processes: unknown[]; error?: string };
  assert.equal(result.ok, true, result.error ?? 'helper failed');
  assert.ok(Array.isArray(result.processes));
});

test('over the real protocol the shared parameter limits do not reject a full-size render request', { timeout: 20000 }, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'app-control-stdio-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== UI_AUTOMATION_ENV)) as Record<string, string>;
  const client = new Client({ name: 'app-control-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: workspace, env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['attach_magicavoxel_app', 'set_app_camera', 'export_native_render', 'export_app_camera_snapshot', 'export_native_sequence']) assert.ok(names.includes(name), name);
    const result = await client.callTool({ name: 'export_native_render', arguments: { path: 'out/render.png', imageWidth: 1920, imageHeight: 1080 } });
    assert.equal(result.isError, true);
    const message = (result.content as { text: string }[])[0]!.text;
    assert.match(message, process.platform === 'win32' ? /MAGICVOXEL_MCP_UI_AUTOMATION=1/ : /only available on Windows/);
    assert.doesNotMatch(message, /exceeds/);
    for (const [name, args] of [
      ['export_app_camera_snapshot', { path: 'out/camera.vox', cameraId: 9 }],
      ['export_native_sequence', { path: 'out/spin.png', kind: 'turntable', frames: 2 }],
    ] as const) {
      const disabled = await client.callTool({ name, arguments: args });
      assert.equal(disabled.isError, true);
      assert.match((disabled.content as { text: string }[])[0]!.text, process.platform === 'win32' ? /MAGICVOXEL_MCP_UI_AUTOMATION=1/ : /only available on Windows/);
    }
  } finally { await client.close(); await transport.close(); }
});

test('the output path typed into the dialog must be a plain absolute path', () => {
  checkTypablePath('C:\\work\\out\\night.png');
  checkTypablePath('C:/work/out/night.png');
  for (const bad of ['night.png', '\\\\server\\share\\a.png', 'C:\\a\r\n.png', 'C:\\%TEMP%\\a.png', 'C:\\a*.png', 'C:\\a\\b:c.png', 'C:\\' + 'x'.repeat(260)]) assert.throws(() => checkTypablePath(bad), /absolute path|too long/, bad);
});

test('a render path with unsafe characters is rejected before any input is sent', { skip: process.platform !== 'win32' }, async t => {
  let calls = 0;
  const f = await renderFixture(t, () => { calls++; });
  const before = f.steps.length;
  const result = await f.h.call('export_native_render', { path: path.join(f.h.workspace, 'a%TEMP%.png'), imageWidth: 8, imageHeight: 8 });
  assert.equal(result.ok, false);
  assert.equal(f.steps.length, before);
  assert.equal(calls, 0);
});

test('only the calibrated application version can be attached unless explicitly overridden', async t => {
  const install = makeFakeInstall({ readme: '[MagicaVoxel]\r\nversion : 0.99.8.0\r\nos : win64\r\n' });
  t.after(() => install.cleanup());
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-control-ver-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const register = (env: Record<string, string>) => {
    const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler }>();
    registerAppControlTools((d, h) => { tools.set(d.name, { schema: d.inputSchema, handler: h }); }, new FilePolicy(workspace), new MagicaConfig(install.exe), { platform: 'win32', env: { [UI_AUTOMATION_ENV]: '1', ...env }, run: async () => ({ ok: true, processes: [process1(install.exe)] }) });
    return () => tools.get('attach_magicavoxel_app')!.handler({} as never);
  };
  await assert.rejects(register({})(), new RegExp(`calibrated for MagicaVoxel ${CALIBRATED_VERSION.replace(/\./g, '\\.')}, found 0\\.99\\.8\\.0`));
  const ok = await register({ [UI_ANY_VERSION_ENV]: '1' })();
  assert.equal(JSON.parse((ok.content[0] as { text: string }).text).attached, true);
});

test('a stale file that appears with an old timestamp is rejected as not written by this run', { skip: process.platform !== 'win32' }, async t => {
  const f = await renderFixture(t, file => { fs.writeFileSync(file, png(8, 8)); const old = new Date(Date.now() - 3600_000); fs.utimesSync(file, old, old); });
  assert.match(((await f.h.call('export_native_render', { path: f.out, imageWidth: 8, imageHeight: 8, timeoutSeconds: 30 })) as { error: string }).error, /not written by this render/);
});

test('two live operations never overlap', async t => {
  let running = 0, peak = 0;
  const h = setup(t, { run: async (_s, input) => {
    if ((input as { mode: string }).mode === 'list') return { ok: true, processes: [process1(h.install.exe)] };
    running++; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 20));
    running--;
    return { ok: true, steps: [] };
  } });
  await h.call('attach_magicavoxel_app');
  const results = await Promise.all([h.call('set_app_camera', { ry: 1 }), h.call('set_app_camera', { ry: 2 }), h.call('set_app_camera', { ry: 3 })]);
  assert.ok(results.every(r => r.ok));
  assert.equal(peak, 1);
});

test('the helper is given a time budget and the script checks the foreground before every input event', async t => {
  const seen: { budgetMs: number }[] = [];
  const h = setup(t, { run: async (_s, input) => {
    if ((input as { mode: string }).mode === 'list') return { ok: true, processes: [process1(h.install.exe)] };
    seen.push(input as { budgetMs: number });
    return { ok: true, steps: [] };
  } });
  await h.call('attach_magicavoxel_app');
  await h.call('set_app_camera', { ry: 1 });
  assert.ok(seen[0]!.budgetMs > 0 && seen[0]!.budgetMs < 120000);
  assert.match(UI_SCRIPT, /static void Send\(INPUT i\) \{ Guard\(\); SendRaw\(i\); \}/);
  assert.match(UI_SCRIPT, /WindowFromPoint\(p\)/);
  assert.doesNotMatch(UI_SCRIPT, /keybd_event/, 'no synthetic key may be sent before the pinned window owns the foreground');
  assert.doesNotMatch(UI_SCRIPT, /0x08\)/, 'the console field is never cleared with Backspace');
});

test('a helper that exits early or cannot start is an error and cannot crash the server', async () => {
  const fake = (behavior: 'epipe' | 'spawn-error') => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    child.stdin.end = (() => { queueMicrotask(() => { if (behavior === 'epipe') { child.stdin.emit('error', new Error('write EPIPE')); child.emit('close', 1); } else child.emit('error', new Error('spawn powershell.exe ENOENT')); }); return child.stdin; }) as never;
    return child;
  };
  await assert.rejects(makeRunner((() => fake('epipe')) as never)('x', { a: 1 }, 5000), /returned no result/);
  await assert.rejects(makeRunner((() => fake('spawn-error')) as never)('x', { a: 1 }, 5000), /ENOENT/);
});

test('non-ASCII input is escaped so no console code page can alter it', async () => {
  let written = '';
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  child.stdin.on('data', (d: Buffer) => { written += d.toString('latin1'); });
  const promise = makeRunner((() => child) as never)('x', { path: 'C:\\Users\\\u00fcser\\\u4e2d.png' }, 5000);
  child.stdout.write('{"ok":true}\n'); child.emit('close', 0);
  assert.deepEqual(await promise, { ok: true });
  assert.ok(/^[\x00-\x7f]*$/.test(written), 'only ASCII reaches the helper');
  assert.equal(JSON.parse(written).script, 'x');
  assert.deepEqual(JSON.parse(JSON.parse(written).payload), { path: 'C:\\Users\\\u00fcser\\\u4e2d.png' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { makeRunner, registerAppControlTools, UI_AUTOMATION_ENV, type AppControlDeps } from '../src/appControl.js';
import { runWithRequestSignal } from '../src/requestContext.js';
import { FilePolicy } from '../src/files.js';
import { MagicaConfig } from '../src/magicaConfig.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';
import { PNG } from 'pngjs';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const shader = '// xs_begin\n// xs_end\nfloat map(vec3 v) { float n = v.x; for (int j = 0; j < 4000; j++) { n = sin(n) + 0.4; } return n; }';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('aborting the native helper kills it and waits for close before rejecting', async () => {
  const controller = new AbortController();
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; return true; } });
  const run = makeRunner((() => child) as never);
  const pending = runWithRequestSignal(controller.signal, () => run('fake script', {}, 1000));
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await pause(10);
  const killed = kills;
  const settledBeforeClose = settled;
  child.stdout.write('{"ok":true}\n');
  child.emit('close', 0);
  const result = await pending.then(() => 'success', e => String(e));
  assert.equal(killed, 1, 'the helper must receive a termination request on abort');
  assert.equal(settledBeforeClose, false, 'cancellation cannot release the queue before the helper closes');
  assert.match(result, /abort|cancel/i, 'a late helper result cannot turn cancellation into success');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

function fakeUi(deps: AppControlDeps = {}) {
  const install = makeFakeInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-render-'));
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: (args: never) => Promise<CallToolResult> }>();
  registerAppControlTools((definition, handler) => { tools.set(definition.name, { schema: definition.inputSchema, handler }); }, new FilePolicy(root), new MagicaConfig(install.exe), {
    platform: 'win32', env: { [UI_AUTOMATION_ENV]: '1' },
    run: async (_script, input) => (input as { mode: string }).mode === 'list'
      ? { ok: true, processes: [{ pid: 42, exe: install.exe, startFileTime: '1234' }] }
      : { ok: true, steps: [] },
    ...deps,
  });
  return {
    root, exe: install.exe,
    call: (name: string, args: Record<string, unknown> = {}) => { const tool = tools.get(name)!; return tool.handler(tool.schema.parse(args) as never); },
    cleanup: () => { install.cleanup(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('camera rejects cancellation arriving during an injected helper instead of reporting submission success', async () => {
  const controller = new AbortController();
  const fixture = fakeUi({ run: async (_script, input) => {
    if ((input as { mode: string }).mode === 'list') return { ok: true, processes: [{ pid: 42, exe: fixture.exe, startFileTime: '1234' }] };
    controller.abort();
    return { ok: true, steps: ['console'] };
  } });
  try {
    await fixture.call('attach_magicavoxel_app');
    await assert.rejects(runWithRequestSignal(controller.signal, () => fixture.call('set_app_camera', { ry: 1 })), /abort|cancel/i);
  } finally { fixture.cleanup(); }
});

test('live-operation queue waits for an aborted helper and skips a separately cancelled queued camera', async () => {
  const activeController = new AbortController(), queuedController = new AbortController();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let submissions = 0;
  const fixture = fakeUi({ run: async (_script, input) => {
    if ((input as { mode: string }).mode === 'list') return { ok: true, processes: [{ pid: 42, exe: fixture.exe, startFileTime: '1234' }] };
    submissions++;
    if (submissions === 1) await barrier;
    return { ok: true, steps: ['console'] };
  } });
  try {
    await fixture.call('attach_magicavoxel_app');
    const active = runWithRequestSignal(activeController.signal, () => fixture.call('set_app_camera', { ry: 1 }));
    const activeRejected = assert.rejects(active, /abort|cancel/i);
    let activeSettled = false;
    void active.then(() => { activeSettled = true; }, () => { activeSettled = true; });
    await pause(10);
    const queued = runWithRequestSignal(queuedController.signal, () => fixture.call('set_app_camera', { ry: 2 }));
    const queuedOutcome = queued.then(() => 'success', error => String(error));
    const next = fixture.call('set_app_camera', { ry: 3 });
    activeController.abort(); queuedController.abort();
    await pause(10);
    assert.equal(activeSettled, false, 'the active helper must really settle before releasing the lock');
    assert.equal(submissions, 1);
    release();
    await activeRejected;
    const cancelled = await queuedOutcome;
    await next;
    assert.match(cancelled, /abort|cancel/i);
    assert.equal(submissions, 2, 'the cancelled queued camera must never reach the helper');
  } finally { release(); fixture.cleanup(); }
});

test('cancelled process listing cannot leave an application identity pinned', async () => {
  const controller = new AbortController();
  const fixture = fakeUi({ run: async () => {
    controller.abort();
    return { ok: true, processes: [{ pid: 42, exe: fixture.exe, startFileTime: '1234' }] };
  } });
  try {
    await assert.rejects(runWithRequestSignal(controller.signal, () => fixture.call('attach_magicavoxel_app')), /abort|cancel/i);
    await assert.rejects(fixture.call('set_app_camera', { ry: 1 }), /No application is attached/);
  } finally { fixture.cleanup(); }
});

test('render-file polling rejects cancellation even when a valid file appears during the poll', { skip: process.platform !== 'win32' }, async () => {
  const controller = new AbortController();
  let polls = 0, clock = 0;
  const fixture = fakeUi({ settleSeconds: 0, now: () => clock, sleep: async ms => {
    clock += ms;
    polls++;
    if (polls === 1) {
      const image = new PNG({ width: 8, height: 8 });
      fs.writeFileSync(path.join(fixture.root, 'render.png'), PNG.sync.write(image));
      controller.abort();
    }
  } });
  try {
    await fixture.call('attach_magicavoxel_app');
    await assert.rejects(runWithRequestSignal(controller.signal, () => fixture.call('export_native_render', { path: path.join(fixture.root, 'render.png'), imageWidth: 8, imageHeight: 8, timeoutSeconds: 30 })), /cancel|abort/i);
    assert.equal(polls, 1, 'do not keep polling or verify output after cancellation');
    assert.ok(!(await fixture.call('set_app_camera', { ry: 1 })).isError, 'the live-operation lock must be reusable');
  } finally { fixture.cleanup(); }
});

function json(result: Awaited<ReturnType<Client['callTool']>>) {
  const block = result.content[0];
  assert.ok(block?.type === 'text');
  return JSON.parse(block.text);
}

test('stdio cancellation skips a queued create_model without mutating registry', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-queue-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'cancellation-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { id } = json(await client.callTool({ name: 'create_model', arguments: { sizeX: 64, sizeY: 64, sizeZ: 64 } }));
    const active = client.callTool({ name: 'run_xs_shader', arguments: { id, source: shader, timeLimitMs: 1800 } });
    await pause(150);
    await client.ping();
    const controller = new AbortController();
    const queued = client.callTool({ name: 'create_model', arguments: { sizeX: 2, sizeY: 2, sizeZ: 2 } }, { signal: controller.signal });
    const rejected = assert.rejects(queued, /abort|cancel/i);
    await pause(100);
    controller.abort();
    await rejected;
    assert.equal((await active).isError, true);
    assert.equal(json(await client.callTool({ name: 'list_models', arguments: {} })).length, 1);
  } finally {
    await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stdio cancellation stops an active shader, rolls back and permits subsequent edits promptly', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-shader-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'cancellation-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { id } = json(await client.callTool({ name: 'create_model', arguments: { sizeX: 64, sizeY: 64, sizeZ: 64 } }));
    await client.callTool({ name: 'set_voxels', arguments: { id, voxels: [{ x: 1, y: 2, z: 3, i: 7 }] } });
    const controller = new AbortController();
    const active = client.callTool({ name: 'run_xs_shader', arguments: { id, source: shader, timeLimitMs: 4000 } }, { signal: controller.signal });
    const rejected = assert.rejects(active, /abort|cancel/i);
    await pause(200);
    await client.ping();
    const started = performance.now();
    controller.abort();
    await rejected;
    const next = await client.callTool({ name: 'create_model', arguments: { sizeX: 3, sizeY: 3, sizeZ: 3 } });
    assert.ok(performance.now() - started < 1500, 'the next edit must not wait for the shader deadline');
    assert.ok(!next.isError);
    assert.equal(json(await client.callTool({ name: 'get_model_info', arguments: { id } })).voxelCount, 1);
    assert.equal(json(await client.callTool({ name: 'list_models', arguments: {} })).length, 2);
    await client.callTool({ name: 'undo', arguments: {} });
    assert.equal(json(await client.callTool({ name: 'list_models', arguments: {} })).length, 1, 'cancelled shader must not commit an undo entry');
    assert.equal(json(await client.callTool({ name: 'get_model_info', arguments: { id } })).voxelCount, 1);
  } finally {
    await client.close(); await transport.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

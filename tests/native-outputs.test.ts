import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { registerAppControlTools, UI_AUTOMATION_ENV, UI_SCRIPT } from '../src/appControl.js';
import { FilePolicy } from '../src/files.js';
import { MagicaConfig } from '../src/magicaConfig.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';
import { createVOXScene, encodeVOXScene } from '../src/scene.js';
import { PNG } from 'pngjs';
import { registerNativeOutputs } from '../src/appNativeOutputs.js';

function fixture(t: { after(fn: () => void): void }, produce: (steps: { op: string; text?: string; path?: string }[]) => void) {
  const install = makeFakeInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-output-'));
  t.after(() => { install.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: (args: never) => Promise<CallToolResult> }>();
  let clock = 0;
  registerAppControlTools((d, h) => { tools.set(d.name, { schema: d.inputSchema, handler: h }); }, new FilePolicy(root), new MagicaConfig(install.exe), {
    platform: 'win32', env: { [UI_AUTOMATION_ENV]: '1' }, settleSeconds: 0, now: () => clock, sleep: async ms => { clock += ms; },
    run: async (_s, data) => {
      if ((data as { mode: string }).mode === 'list') return { ok: true, processes: [{ pid: 42, exe: install.exe, startFileTime: '123' }] };
      produce((data as { steps: { op: string; text?: string; path?: string }[] }).steps);
      return { ok: true, steps: [] };
    },
  });
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.get(name); assert.ok(tool, name);
    const result = await tool.handler(tool.schema.parse(input) as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { tools, root, call };
}

test('camera snapshot tool returns actual native saved values rather than the requested pose', { skip: process.platform !== 'win32' }, async t => {
  let steps: { op: string; text?: string; path?: string }[] = [];
  const f = fixture(t, value => {
    steps = value;
    if (!value.some(s => s.op === 'save_dialog')) return;
    const scene = createVOXScene([{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] }]);
    scene.render.cameras.push({ id: 9, attributes: { _mode: 'pers', _focus: '0 0 56', _angle: '-20 323 0', _radius: '253.512', _fov: '45' } });
    fs.writeFileSync(value.find(s => s.op === 'save_dialog')!.path!, encodeVOXScene(scene));
  });
  await f.call('attach_magicavoxel_app');
  const out = await f.call('export_app_camera_snapshot', { path: path.join(f.root, 'snapshot.vox'), cameraId: 9 });
  assert.equal(out.camera.attributes._angle, '-20 323 0');
  assert.equal(out.camera.id, 9);
  assert.equal(out.source, 'native_saved_camera');
  assert.ok(steps.some(s => s.op === 'save_project_as'));
  await assert.rejects(f.call('export_app_camera_snapshot', { path: path.join(f.root, 'snapshot.vox') }), /exist/);
});

test('native sequence validates every expected frame and returns actual common dimensions', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, steps => {
    const base = steps.find(s => s.op === 'save_dialog')!.path!;
    const image = PNG.sync.write(new PNG({ width: 16, height: 12 }));
    for (let i = 0; i < 2; i++) fs.writeFileSync(base.replace(/\.png$/i, ` (${String(i).padStart(4, '0')}).png`), image);
  });
  await f.call('attach_magicavoxel_app');
  const result = await f.call('export_native_sequence', { path: path.join(f.root, 'spin.png'), kind: 'turntable', frames: 2, angle: 90, timeoutSeconds: 30 });
  assert.equal(result.frames.length, 2);
  assert.equal(result.width, 16);
  assert.equal(result.height, 12);
  assert.equal(result.verified.pngStructureAndChecksums, true);
  await assert.rejects(f.call('export_native_sequence', { path: path.join(f.root, 'spin.png'), kind: 'turntable', frames: 2 }), /exist/);
});

test('native snapshot/sequence tools are strict opt-in additions and file dialogs are positively recognised', t => {
  const f = fixture(t, () => {});
  for (const name of ['export_app_camera_snapshot', 'export_native_sequence']) {
    const tool = f.tools.get(name); assert.ok(tool, name);
    assert.throws(() => tool.schema.parse({ path: 'C:/out.png', kind: 'turntable', extra: true }));
  }
  assert.match(UI_SCRIPT, /save_project_as/);
  assert.match(UI_SCRIPT, /SetSavePath/);
  assert.match(UI_SCRIPT, /GetDlgCtrlID/);
  assert.match(UI_SCRIPT, /FileNameEdit/);
});

// Exercise filesystem verification independently of the Windows input adapter on every CI host.
function portableFixture(t: { after(fn: () => void): void }, produce: (steps: { op: string; text?: string; path?: string }[]) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: (args: never) => Promise<CallToolResult> }>();
  let clock = 0, calls = 0;
  registerNativeOutputs((d, h) => { tools.set(d.name, { schema: d.inputSchema, handler: h }); }, new FilePolicy(root), {
    enabled: () => {}, exclusive: fn => fn(), checkPath: p => assert.ok(path.isAbsolute(p)),
    sleep: async ms => { clock += ms; }, now: () => clock, settle: 0,
    execute: async input => {
      calls++;
      produce((input as { op: string; text?: string; path?: string }[]).map(s => ({ ...s, ...(s.path ? { path: s.path.replaceAll('\\', path.sep) } : {}) })));
      return [];
    },
  });
  return { root, calls: () => calls, call: async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    return tool.handler(tool.schema.parse(args) as never);
  } };
}
const framePath = (base: string, i: number) => base.slice(0, -4) + ` (${String(i).padStart(4, '0')}).png`;

test('sequence verifier times out when the final native frame is absent', async t => {
  const f = portableFixture(t, steps => {
    const base = steps.find(s => s.op === 'save_dialog')!.path!;
    fs.writeFileSync(framePath(base, 0), PNG.sync.write(new PNG({ width: 2, height: 2 })));
  });
  await assert.rejects(f.call('export_native_sequence', { path: path.join(f.root, 'partial.png'), kind: 'turntable', frames: 2, timeoutSeconds: 30 }), /timed out/);
  assert.equal(f.calls(), 1);
});

for (const fault of ['crc', 'dimensions', 'old-timestamp'] as const) test(`sequence verifier rejects ${fault}`, async t => {
  const f = portableFixture(t, steps => {
    const base = steps.find(s => s.op === 'save_dialog')!.path!;
    const first = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const second = PNG.sync.write(new PNG({ width: fault === 'dimensions' ? 3 : 2, height: 2 }));
    if (fault === 'crc') second[second.length - 1] = second[second.length - 1]! ^ 1;
    fs.writeFileSync(framePath(base, 0), first); fs.writeFileSync(framePath(base, 1), second);
    if (fault === 'old-timestamp') fs.utimesSync(framePath(base, 1), new Date(1000), new Date(1000));
  });
  await assert.rejects(f.call('export_native_sequence', { path: path.join(f.root, 'bad.png'), kind: 'turntable', frames: 2, timeoutSeconds: 30 }), fault === 'crc' ? /CRC|checksum/i : fault === 'dimensions' ? /dimensions/ : /timestamp/);
});

test('animation suffixes are the inclusive native timeline indices, not zero-based output positions', async t => {
  const f = portableFixture(t, steps => {
    assert.deepEqual(steps.filter(s=>s.op==='console').map(s=>s.text), ['set a_min 0','set a_max 3','set a_min 2','set pt_anim_f0 2','set pt_anim_f1 3']);
    const base = steps.find(s => s.op === 'save_dialog')!.path!;
    for (const i of [2, 3]) fs.writeFileSync(framePath(base, i), PNG.sync.write(new PNG({ width: 2, height: 2 })));
  });
  const r = await f.call('export_native_sequence', { path: path.join(f.root, 'anim.png'), kind: 'animation', start: 2, end: 3 });
  const out = JSON.parse((r.content[0] as { text: string }).text);
  assert.deepEqual(out.frames.map((v: { frameIndex: number }) => v.frameIndex), [2, 3]);
});

test('contradictory native sequence settings are refused before helper execution', async t => {
  const f = portableFixture(t, () => { throw new Error('must not execute'); });
  for (const input of [
    { kind: 'animation', start: 3, end: 2 }, { kind: 'animation', start: 0, end: 120 },
    { kind: 'animation', start: 0, end: 1, frames: 2 }, { kind: 'turntable', start: 0 },
    { kind: 'turntable', frames: 121 }, { kind: 'animation' },
  ]) await assert.rejects(f.call('export_native_sequence', { path: path.join(f.root, 'none.png'), ...input }));
  assert.equal(f.calls(), 0);
});

test('camera snapshot verifier rejects a fresh project missing the captured slot', async t => {
  const f = portableFixture(t, steps => {
    const save = steps.find(s => s.op === 'save_dialog');
    if (save) fs.writeFileSync(save.path!, encodeVOXScene(createVOXScene([{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] }])));
  });
  await assert.rejects(f.call('export_app_camera_snapshot', { path: path.join(f.root, 'no-camera.vox') }), /requested camera slot/);
});

test('animation may render the final native timeline index while retaining the 120-output batch cap', async t => {
  const f=portableFixture(t,steps=>{const base=steps.find(s=>s.op==='save_dialog')!.path!;fs.writeFileSync(framePath(base,360),PNG.sync.write(new PNG({width:2,height:2})));});
  const r=await f.call('export_native_sequence',{path:path.join(f.root,'late.png'),kind:'animation',start:360,end:360});
  assert.equal(JSON.parse((r.content[0] as {text:string}).text).frames[0].frameIndex,360);
});

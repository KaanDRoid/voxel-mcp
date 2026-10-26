import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVoxFile } from '../src/openApp.js';

type Call = { command: string; args: string[]; options: Record<string, unknown> };
function mockSpawn(outcome: 'spawn' | 'error' = 'spawn') {
  const calls: Call[] = [];
  const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void; unrefCalled?: boolean };
    child.unref = () => { child.unrefCalled = true; };
    setImmediate(() => outcome === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('spawn failed')));
    return child;
  }) as never;
  return { calls, spawnFn };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-open-'));
  const exe = path.join(dir, 'MagicaVoxel.exe'), vox = path.join(dir, 'a.vox'), txt = path.join(dir, 'a.txt');
  for (const f of [exe, vox, txt]) fs.writeFileSync(f, 'x');
  return { dir, exe, vox, txt, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('an unconfigured executable points at the environment variables, not at a removed tool', async () => {
  const { spawnFn, calls } = mockSpawn();
  await assert.rejects(openVoxFile({ exe: null, file: 'a.vox', spawnFn }), (error: Error) => {
    assert.match(error.message, /MAGICAVOXEL_PATH/);
    assert.doesNotMatch(error.message, /set_[a-z]+_path/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('only existing .vox files are opened and nothing is spawned otherwise', async () => {
  const f = fixture();
  const { spawnFn, calls } = mockSpawn();
  try {
    await assert.rejects(openVoxFile({ exe: f.exe, file: f.txt, spawnFn }), /\.vox/);
    await assert.rejects(openVoxFile({ exe: f.exe, file: path.join(f.dir, 'missing.vox'), spawnFn }), /not found/i);
    await assert.rejects(openVoxFile({ exe: f.exe, file: f.dir + path.sep, spawnFn }), /\.vox|not found|file/i);
    assert.equal(calls.length, 0);
  } finally { f.cleanup(); }
});

test('the application starts with the installation folder as working directory', async () => {
  const f = fixture();
  const first = mockSpawn(), second = mockSpawn();
  try {
    await openVoxFile({ exe: f.exe, file: f.vox, spawnFn: first.spawnFn });
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0]!.command, f.exe);
    assert.deepEqual(first.calls[0]!.args, [f.vox]);
    assert.equal(first.calls[0]!.options.cwd, path.dirname(f.exe));
    assert.equal(first.calls[0]!.options.shell, false);
    assert.equal(first.calls[0]!.options.detached, true);
    await openVoxFile({ exe: f.exe, file: f.vox, cwd: f.dir, spawnFn: second.spawnFn });
    assert.equal(second.calls[0]!.options.cwd, f.dir);
  } finally { f.cleanup(); }
});

test('spawn failures are reported as errors', async () => {
  const f = fixture();
  try {
    await assert.rejects(openVoxFile({ exe: f.exe, file: f.vox, spawnFn: mockSpawn('error').spawnFn }), /spawn failed/);
  } finally { f.cleanup(); }
});

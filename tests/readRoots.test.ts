import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilePolicy } from '../src/files.js';
import { installReadRoots, resolveInstall } from '../src/magicaInstall.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';

function setup() {
  const fake = makeFakeInstall();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-ws-'));
  fs.writeFileSync(path.join(fake.root, 'vox', 'room.vox'), 'VOX ');
  fs.writeFileSync(path.join(fake.root, 'palette', 'pal0.png'), 'png');
  const files = new FilePolicy(workspace);
  for (const root of installReadRoots(resolveInstall({ MAGICAVOXEL_HOME: fake.root }))) files.addReadRoot(root.dir, { allowExt: root.allowExt });
  return { fake, workspace, files, cleanup: () => { fake.cleanup(); fs.rmSync(workspace, { recursive: true, force: true }); } };
}

test('samples, palettes, shaders, ibl files and config.txt can be read from the installation', () => {
  const { fake, files, cleanup } = setup();
  try {
    for (const rel of ['vox/room.vox', 'palette/pal0.png', 'shader/round.txt', 'ibl/sky.hdr', 'config/config.txt']) {
      const resolved = files.resolve(path.join(fake.root, rel), 'read');
      assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(fake.root, rel)));
    }
  } finally { cleanup(); }
});

test('the installation is never writable and executables, cache and other folders stay unreadable', () => {
  const { fake, files, cleanup } = setup();
  try {
    for (const mode of ['write', 'directory', 'outputDirectory'] as const) {
      assert.throws(() => files.resolve(path.join(fake.root, 'config', 'config.txt'), mode), /outside/);
      assert.throws(() => files.resolve(path.join(fake.root, 'vox'), mode), /outside/);
    }
    assert.throws(() => files.prepareOutput(path.join(fake.root, 'vox', 'new.vox')), /outside/);
    assert.throws(() => files.prepareOutput(path.join(fake.root, 'config', 'config.txt')), /outside/);
    assert.throws(() => files.resolve(fake.exe, 'read'), /outside/);
    assert.throws(() => files.resolve(path.join(fake.root, 'cache', 'backup.vox'), 'read'), /outside/);
    assert.throws(() => files.resolve(path.join(fake.root, 'readme.txt'), 'read'), /outside/);
    assert.throws(() => files.resolve(path.join(fake.root, 'vox', 'room.exe'), 'read'), /not readable|outside|ENOENT/);
    fs.writeFileSync(path.join(fake.root, 'vox', 'tool.dll'), 'x');
    fs.writeFileSync(path.join(fake.root, 'config', 'notes.bin'), 'x');
    assert.throws(() => files.resolve(path.join(fake.root, 'vox', 'tool.dll'), 'read'), /not readable/);
    assert.throws(() => files.resolve(path.join(fake.root, 'config', 'notes.bin'), 'read'), /not readable/);
    assert.throws(() => files.resolve(path.join(fake.root, 'palette', 'room.vox'), 'read'), /not readable|ENOENT/);
  } finally { cleanup(); }
});

test('traversal and symlinks cannot escape a read root', () => {
  const { fake, workspace, files, cleanup } = setup();
  try {
    assert.throws(() => files.resolve(path.join(fake.root, 'vox', '..', 'MagicaVoxel.exe'), 'read'), /outside/);
    assert.throws(() => files.resolve(path.join(fake.root, 'vox', '..', 'cache', 'backup.vox'), 'read'), /outside/);
    assert.throws(() => files.resolve(path.join(fake.root, 'vox', '..', '..', 'x.vox'), 'read'), /outside|ENOENT/);
    const secret = path.join(workspace, 'secret.vox');
    fs.writeFileSync(secret, 'x');
    const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-out-'));
    fs.writeFileSync(path.join(outsider, 'a.vox'), 'x');
    try {
      fs.symlinkSync(path.join(outsider, 'a.vox'), path.join(fake.root, 'vox', 'link.vox'));
      assert.throws(() => files.resolve(path.join(fake.root, 'vox', 'link.vox'), 'read'), /outside/);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    fs.rmSync(outsider, { recursive: true, force: true });
    // workspace behavior is unchanged
    assert.equal(files.resolve('secret.vox', 'read'), secret);
    assert.throws(() => files.resolve(path.join(os.tmpdir(), 'x.vox'), 'read'), /outside/);
  } finally { cleanup(); }
});

test('executable extensions cannot be allowed on a read root', () => {
  const { fake, files, cleanup } = setup();
  try {
    assert.throws(() => files.addReadRoot(fake.root, { allowExt: ['.exe'] }), /executable/i);
    assert.throws(() => files.addReadRoot(path.join(fake.root, 'missing'), { allowExt: ['.vox'] }));
  } finally { cleanup(); }
});

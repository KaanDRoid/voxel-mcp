import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FilePolicy } from '../src/files.js';

test('workspace paths reject traversal and allow nested output directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-files-'));
  try {
    const policy = new FilePolicy(root);
    assert.throws(() => policy.resolve('../outside.vox', 'write'), /workspace/);
    assert.throws(() => policy.resolve('', 'write'), /path/i);
    assert.equal(policy.resolve('nested/model.vox', 'write'), path.join(root, 'nested/model.vox'));
    fs.writeFileSync(path.join(root, 'input.vox'), 'VOX ');
    assert.equal(policy.resolve('input.vox', 'read'), path.join(root, 'input.vox'));
    assert.throws(() => policy.resolve('missing.vox', 'read'), /exist|ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace paths reject symbolic-link escapes on reads and writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-links-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.vox'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const policy = new FilePolicy(root);
    assert.throws(() => policy.resolve('escape/secret.vox', 'read'), /workspace/);
    assert.throws(() => policy.resolve('escape/new.vox', 'write'), /workspace/);
    assert.throws(() => policy.resolve('escape/new/sub.vox', 'write'), /workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('oversized input files are rejected before parsing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-limit-'));
  try {
    fs.writeFileSync(path.join(root, 'input.vox'), Buffer.alloc(20));
    assert.throws(() => new FilePolicy(root, 16).resolve('input.vox', 'read'), /limit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** Directory link that works without privileges: a junction on Windows, a symlink elsewhere. */
const dirLink = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const fresh = () => ({
  root: fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-links-')),
  outside: fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-outside-')),
});
const cleanup = (...dirs: string[]) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

test('directory links (junctions on Windows) are exercised on every platform, never skipped', () => {
  const { root, outside } = fresh();
  try {
    dirLink(outside, path.join(root, 'link'));
    assert.equal(fs.lstatSync(path.join(root, 'link')).isSymbolicLink(), true);
    assert.throws(() => new FilePolicy(root).resolve('link', 'directory'), /workspace/);
  } finally { cleanup(root, outside); }
});

test('links nested below the workspace are followed and rejected when they leave it', () => {
  const { root, outside } = fresh();
  try {
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(outside, 'secret.vox'), 'secret');
    dirLink(outside, path.join(root, 'a', 'deep'));
    const policy = new FilePolicy(root);
    assert.throws(() => policy.resolve('a/deep/secret.vox', 'read'), /workspace/);
    assert.throws(() => policy.resolve('a/deep/out.vox', 'write'), /workspace/);
    assert.throws(() => policy.prepareOutput('a/deep/frames', true), /workspace/);
    assert.throws(() => policy.resolve('a/deep', 'directory'), /workspace/);
  } finally { cleanup(root, outside); }
});

test('links that stay inside the workspace remain usable', () => {
  const { root, outside } = fresh();
  try {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'model.vox'), 'ok');
    dirLink(path.join(root, 'real'), path.join(root, 'alias'));
    const policy = new FilePolicy(root);
    assert.equal(fs.realpathSync(policy.resolve('alias/model.vox', 'read')), fs.realpathSync(path.join(root, 'real', 'model.vox')));
    assert.doesNotThrow(() => policy.resolve('alias/new.vox', 'write'));
  } finally { cleanup(root, outside); }
});

test('dangling directory links are refused instead of being created through', () => {
  const { root, outside } = fresh();
  try {
    const gone = path.join(outside, 'gone');
    fs.mkdirSync(gone);
    dirLink(gone, path.join(root, 'dangling'));
    fs.rmdirSync(gone);
    const policy = new FilePolicy(root);
    assert.throws(() => policy.resolve('dangling/new.vox', 'write'), /symlink|workspace|exist/i);
    assert.equal(fs.existsSync(gone), false);
  } finally { cleanup(root, outside); }
});

test('file symbolic links that point outside are rejected (skipped when the OS denies link creation)', (t) => {
  const { root, outside } = fresh();
  try {
    fs.writeFileSync(path.join(outside, 'secret.vox'), 'secret');
    try { fs.symlinkSync(path.join(outside, 'secret.vox'), path.join(root, 'file-link.vox'), 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlinks need a privilege on this system'); return; } throw error; }
    const policy = new FilePolicy(root);
    assert.throws(() => policy.resolve('file-link.vox', 'read'), /workspace/);
  } finally { cleanup(root, outside); }
});

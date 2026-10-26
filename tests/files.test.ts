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

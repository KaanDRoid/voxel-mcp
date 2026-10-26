import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstall, tryResolveInstall } from '../src/magicaInstall.js';
import { makeFakeInstall } from './helpers/fakeInstall.js';

test('resolves the installation from the executable path', () => {
  const fake = makeFakeInstall();
  try {
    const install = resolveInstall({ MAGICAVOXEL_PATH: fake.exe });
    assert.equal(install.root, fake.root);
    assert.equal(install.exe, fs.realpathSync(fake.exe));
    assert.equal(install.version, '0.99.7.2');
    assert.equal(install.os, 'win64');
    assert.equal(install.dirs.vox, path.join(fake.root, 'vox'));
    assert.equal(install.dirs.config, path.join(fake.root, 'config'));
    assert.equal(install.configFile, path.join(fake.root, 'config', 'config.txt'));
  } finally { fake.cleanup(); }
});

test('resolves the installation from MAGICAVOXEL_HOME and prefers the executable variable', () => {
  const a = makeFakeInstall(), b = makeFakeInstall();
  try {
    assert.equal(resolveInstall({ MAGICAVOXEL_HOME: a.root }).root, a.root);
    assert.equal(resolveInstall({ MAGICAVOXEL_HOME: a.root, MAGICAVOXEL_PATH: b.exe }).root, b.root);
  } finally { a.cleanup(); b.cleanup(); }
});

test('reports a missing variable, a wrong executable name and missing folders clearly', () => {
  assert.throws(() => resolveInstall({}), /MAGICAVOXEL_PATH.*MAGICAVOXEL_HOME/);
  const fake = makeFakeInstall({ skip: ['palette', 'ibl'] });
  try {
    assert.throws(() => resolveInstall({ MAGICAVOXEL_HOME: fake.root }), /palette.*ibl|missing/i);
    fs.copyFileSync(fake.exe, path.join(fake.root, 'other.exe'));
    assert.throws(() => resolveInstall({ MAGICAVOXEL_PATH: path.join(fake.root, 'other.exe') }), /MagicaVoxel/);
    assert.throws(() => resolveInstall({ MAGICAVOXEL_HOME: path.join(fake.root, 'nope') }), /not a directory|not found/i);
    const result = tryResolveInstall({ MAGICAVOXEL_HOME: fake.root });
    assert.equal(result.install, undefined);
    assert.match(result.error ?? '', /missing/i);
  } finally { fake.cleanup(); }
});

test('a missing config file or readme is an error but an unreadable version is only unknown', () => {
  const noConfig = makeFakeInstall({ skip: ['config.txt'] });
  const noVersion = makeFakeInstall({ readme: 'nothing useful here' });
  try {
    assert.throws(() => resolveInstall({ MAGICAVOXEL_HOME: noConfig.root }), /config\.txt/);
    assert.equal(resolveInstall({ MAGICAVOXEL_HOME: noVersion.root }).version, undefined);
  } finally { noConfig.cleanup(); noVersion.cleanup(); }
});

test('the real installation resolves when available', { skip: !process.env.MAGICAVOXEL_HOME && !process.env.MAGICAVOXEL_PATH }, () => {
  const install = resolveInstall(process.env);
  assert.match(install.version ?? '', /^\d+\.\d+/);
});

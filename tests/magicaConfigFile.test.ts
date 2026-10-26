import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfigText, readConfigFile } from '../src/magicaConfigFile.js';
import { CONFIG, makeFakeInstall } from './helpers/fakeInstall.js';

test('parses sections, quoted values, long strings and comments', () => {
  const { config, warnings } = parseConfigText(CONFIG, 'C:/mv');
  assert.deepEqual(warnings, []);
  assert.equal(config.workspace!.dir_model, 'C:/mv/vox');
  assert.equal(config.workspace!.dir_ibl, 'C:/mv/ibl');
  assert.equal(config.workspace!.rename_prefix, '-');
  assert.equal(config.workspace!.rename_suffix, '');
  assert.equal(config.io_obj!.scale, 0.1);
  assert.equal(config.io_obj!.axis, 'XZ-Y');
  assert.equal(config.io_obj!.merge, 1);
});

test('resolves the $ convention only at the start of a path', () => {
  const text = "workspace :\n{\n dir_a : [[$]]\n dir_b : [[$/x/y]]\n dir_c : [[D:/abs/$/z]]\n dir_d : [[$\\w]]\n}\n";
  const { config } = parseConfigText(text, 'C:/mv');
  assert.equal(config.workspace!.dir_a, 'C:/mv');
  assert.equal(config.workspace!.dir_b, 'C:/mv/x/y');
  assert.equal(config.workspace!.dir_c, 'D:/abs/$/z');
  assert.equal(config.workspace!.dir_d, 'C:/mv/w');
});

test('parses vectors and fills documented defaults for missing keys', () => {
  const { config } = parseConfigText("io_iso :\n{\n top : '1.17 1.15 1.25' // top\n size : '3'\n}\n", 'C:/mv');
  assert.deepEqual(config.io_iso!.top, [1.17, 1.15, 1.25]);
  assert.equal(config.io_iso!.size, 3);
  assert.equal(config.io_iso!.height, 4);
  assert.equal(config.io_iso!.outline, 1);
  assert.deepEqual(config.io_iso!.left, [0.37, 0.35, 0.55]);
  assert.equal(config.io_obj!.scale, 0.1);
  assert.equal(config.io_obj!.axis, 'XZ-Y');
  assert.equal(config.io_ply!.axis, 'XYZ');
});

test('empty, binary or broken input yields defaults plus warnings, never an exception', () => {
  for (const text of ['', '\u0000\u0001garbage', 'io_obj :\n{\n scale : \'0.5\'\n', 'just words', '{ } } {', 'x :\n{\n k : \'unterminated\n}\n']) {
    const { config, warnings } = parseConfigText(text, 'C:/mv');
    assert.equal(typeof config, 'object');
    assert.ok(Array.isArray(warnings));
    if (text === '') assert.ok(warnings.length > 0);
  }
  assert.equal(parseConfigText('io_obj :\n{\n scale : \'0.5\'\n', 'C:/mv').config.io_obj!.scale, 0.5);
});

test('readConfigFile reads a file read-only and tolerates a missing one', () => {
  const fake = makeFakeInstall();
  try {
    const before = fs.readFileSync(path.join(fake.root, 'config', 'config.txt'));
    assert.equal(readConfigFile(path.join(fake.root, 'config', 'config.txt'), fake.root).config.workspace!.dir_palette, fake.root.split(path.sep).join('/') + '/palette');
    assert.deepEqual(fs.readFileSync(path.join(fake.root, 'config', 'config.txt')), before);
    const missing = readConfigFile(path.join(fake.root, 'nope.txt'), fake.root);
    assert.ok(missing.warnings.length > 0);
  } finally { fake.cleanup(); }
});

test('the real config.txt parses into its ten sections when available', { skip: !process.env.MAGICAVOXEL_HOME }, () => {
  const root = process.env.MAGICAVOXEL_HOME!;
  const { config, warnings } = readConfigFile(path.join(root, 'config', 'config.txt'), root);
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(config).sort(), ['io_2d', 'io_cube', 'io_iso', 'io_mc', 'io_obj', 'io_ply', 'io_point', 'render', 'view', 'workspace']);
});

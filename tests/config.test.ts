import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MagicaConfig } from '../src/magicaConfig.js';

test('MagicaVoxel configuration rejects directories and unrelated executables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicvoxel-config-'));
  try {
    const config = new MagicaConfig();
    assert.throws(() => config.setMagicaPath(root), /file|executable|MagicaVoxel/);
    const other = path.join(root, 'other.exe');
    fs.writeFileSync(other, '');
    assert.throws(() => config.setMagicaPath(other), /MagicaVoxel/);
    const exe = path.join(root, 'MagicaVoxel.exe');
    fs.writeFileSync(exe, '');
    config.setMagicaPath(exe);
    assert.equal(config.getMagicaPath(), fs.realpathSync(exe));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

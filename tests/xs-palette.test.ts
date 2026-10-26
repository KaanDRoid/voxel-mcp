import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileXs, runXsOnVolume } from '../src/xsEval.js';

test('shader palette() uses the official default when the model has no custom palette', () => {
  const program = compileXs('float map(vec3 v) { return palette(1.0).r * 255.0; }');
  const result = runXsOnVolume(program, { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] },
    { args: {}, colorIndex: 1, selections: [1], mode: 'replace', timeLimitMs: 1000 }, 100);
  assert.deepEqual(result.voxels, [{ x: 0, y: 0, z: 0, i: 255 }]);
});

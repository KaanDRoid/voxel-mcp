import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRotation, encodeRotation, composeRotations, rotationFromEulerSteps, determinant, isProperRotation, listProperRotations, applyRotation, IDENTITY_ROTATION, isValidRotation } from '../src/rotation.js';

test('decodes the example from the format notes', () => {
  const r = (1 << 0) | (2 << 2) | (0 << 4) | (1 << 5) | (1 << 6);
  assert.deepEqual(decodeRotation(r), [[0, 1, 0], [0, 0, -1], [-1, 0, 0]]);
  assert.equal(encodeRotation([[0, 1, 0], [0, 0, -1], [-1, 0, 0]]), r);
});

test('observed values from the sample files are proper rotations', () => {
  assert.deepEqual(decodeRotation(17), [[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
  assert.deepEqual(decodeRotation(40), [[1, 0, 0], [0, 0, -1], [0, 1, 0]]);
  for (const r of [17, 40]) assert.ok(isProperRotation(r));
  assert.equal(IDENTITY_ROTATION, 4);
  assert.deepEqual(decodeRotation(4), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('every valid packed value round-trips and there are exactly 24 proper rotations', () => {
  let valid = 0;
  for (let r = 0; r < 128; r++) {
    if (!isValidRotation(r)) { assert.throws(() => decodeRotation(r)); continue; }
    valid++;
    assert.equal(encodeRotation(decodeRotation(r)), r);
  }
  assert.equal(valid, 48);
  const proper = listProperRotations();
  assert.equal(proper.length, 24);
  for (const r of proper) {
    const m = decodeRotation(r);
    assert.equal(determinant(m), 1);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const dot = m[i]![0]! * m[j]![0]! + m[i]![1]! * m[j]![1]! + m[i]![2]! * m[j]![2]!;
      assert.equal(dot, i === j ? 1 : 0);
    }
  }
});

test('encodeRotation rejects non-orthogonal or non-integer matrices', () => {
  assert.throws(() => encodeRotation([[1, 1, 0], [0, 1, 0], [0, 0, 1]]));
  assert.throws(() => encodeRotation([[0.5, 0, 0], [0, 1, 0], [0, 0, 1]]));
  assert.throws(() => encodeRotation([[1, 0, 0], [1, 0, 0], [0, 0, 1]]));
});

test('composition is closed over the 24 rotations and has identity and inverses', () => {
  const all = listProperRotations();
  for (const a of all) {
    assert.equal(composeRotations(a, IDENTITY_ROTATION), a);
    assert.equal(composeRotations(IDENTITY_ROTATION, a), a);
    assert.ok(all.some(b => composeRotations(a, b) === IDENTITY_ROTATION));
    for (const b of all) assert.ok(all.includes(composeRotations(a, b)));
  }
});

test('composition matches applying the rotations one after the other', () => {
  const v: [number, number, number] = [1, 2, 3];
  for (const a of listProperRotations()) for (const b of listProperRotations()) {
    assert.deepEqual(applyRotation(composeRotations(a, b), v), applyRotation(a, applyRotation(b, v)));
  }
});

test('90 degree steps about each axis', () => {
  assert.equal(rotationFromEulerSteps(0, 0, 0), IDENTITY_ROTATION);
  assert.deepEqual(applyRotation(rotationFromEulerSteps(0, 0, 1), [1, 0, 0]), [0, 1, 0]);
  assert.deepEqual(applyRotation(rotationFromEulerSteps(1, 0, 0), [0, 1, 0]), [0, 0, 1]);
  assert.deepEqual(applyRotation(rotationFromEulerSteps(0, 1, 0), [0, 0, 1]), [1, 0, 0]);
  assert.equal(rotationFromEulerSteps(0, 0, 4), IDENTITY_ROTATION);
  assert.equal(rotationFromEulerSteps(0, 0, -1), composeRotations(rotationFromEulerSteps(0, 0, 3), IDENTITY_ROTATION));
  assert.equal(rotationFromEulerSteps(0, 0, 1), 17);
  assert.throws(() => rotationFromEulerSteps(0.5, 0, 0));
});

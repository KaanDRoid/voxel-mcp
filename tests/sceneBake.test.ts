import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVOXScene } from '../src/scene.js';
import { flattenScene, bakeModelInstance, collectInstances } from '../src/sceneBake.js';
import { buildSynthetic, CARS_NODES, cube, corpusSkip, readSample } from './helpers/corpus.js';
import type { SynthNode } from './helpers/corpus.js';

const carsModels = () => [{ size: [15, 34, 13] as [number, number, number], voxels: [[0, 0, 0, 5], [14, 33, 12, 6]] as [number, number, number, number][] }, { size: [15, 32, 14] as [number, number, number], voxels: [[1, 1, 1, 7]] as [number, number, number, number][] }];
const cars = (hidden: number[] = []) => decodeVOXScene(buildSynthetic({ models: carsModels(), nodes: CARS_NODES, hiddenLayers: hidden }));
const cells = (m: { voxels: { x: number; y: number; z: number; i: number }[] }) => m.voxels.map(v => `${v.x},${v.y},${v.z}:${v.i}`).sort();

test('flatten places both cars at their hand-computed world positions', () => {
  // Pivot offset is floor(size/2); car 1 uses _r 17 (90 degrees about Z): (dx,dy,dz) -> (-dy,dx,dz), then _t.
  const { parts, instances } = flattenScene(cars());
  assert.equal(instances, 2);
  assert.equal(parts.length, 1);
  const { model, origin } = parts[0]!;
  assert.deepEqual(origin, [-44, -26, 0]);
  assert.deepEqual([model.sizeX, model.sizeY, model.sizeZ], [55, 41, 13]);
  assert.deepEqual(cells(model), ['0,40,12:6', '33,26,0:5', '54,0,1:7']);
});

test('hidden layers are skipped unless requested', () => {
  const scene = cars([1]);
  const visible = flattenScene(scene);
  assert.equal(visible.skippedHidden, 1);
  assert.equal(visible.instances, 1);
  assert.equal(visible.parts[0]!.model.voxels.length, 2);
  assert.ok(visible.parts[0]!.model.voxels.every(v => v.i !== 7));
  const all = flattenScene(scene, { includeHidden: true });
  assert.equal(all.instances, 2);
  assert.equal(all.parts[0]!.model.voxels.length, 3);
});

test('a hidden transform attribute hides its subtree', () => {
  const nodes: SynthNode[] = CARS_NODES.map(n => (n.id === 2 ? { ...n, attributes: { _hidden: '1' } } : n));
  const scene = decodeVOXScene(buildSynthetic({ models: carsModels(), nodes }));
  assert.equal(flattenScene(scene).instances, 1);
});

test('nested transforms accumulate rotation and translation', () => {
  const nodes: SynthNode[] = [
    { kind: 'nTRN', id: 0, child: 1, frames: [{ _t: '10 0 0', _r: '17' }] },
    { kind: 'nGRP', id: 1, children: [2] },
    { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [{ _t: '5 0 0' }] },
    { kind: 'nSHP', id: 3, models: [{ modelId: 0 }] },
  ];
  const scene = decodeVOXScene(buildSynthetic({ models: [{ size: [1, 1, 1], voxels: [[0, 0, 0, 9]] }], nodes }));
  const [instance] = collectInstances(scene);
  // Child offset (5,0,0) is rotated 90 degrees about Z to (0,5,0) and added to the parent offset (10,0,0).
  assert.deepEqual(instance!.translation, [10, 5, 0]);
  assert.equal(instance!.rotation, 17);
});

test('oversized results fail with a hint and can be split into 256 chunks', () => {
  const nodes: SynthNode[] = [
    { kind: 'nTRN', id: 0, child: 1, frames: [{}] },
    { kind: 'nGRP', id: 1, children: [2, 4] },
    { kind: 'nTRN', id: 2, child: 3, layer: 0, frames: [{ _t: '0 0 0' }] },
    { kind: 'nSHP', id: 3, models: [{ modelId: 0 }] },
    { kind: 'nTRN', id: 4, child: 5, layer: 0, frames: [{ _t: '300 0 0' }] },
    { kind: 'nSHP', id: 5, models: [{ modelId: 0 }] },
  ];
  const scene = decodeVOXScene(buildSynthetic({ models: [cube(2)], nodes }));
  assert.throws(() => flattenScene(scene), /splitIntoChunks/);
  const split = flattenScene(scene, { splitIntoChunks: true });
  assert.equal(split.parts.length, 2);
  assert.deepEqual(split.parts.map(p => p.origin[0]), [-1, 299]);
  assert.equal(split.parts.reduce((n, p) => n + p.model.voxels.length, 0), 16);
});

test('baking one model instance applies only that instance transform', () => {
  const scene = cars();
  const first = bakeModelInstance(scene, 0);
  assert.deepEqual(first.origin, [-44, 0, 0]);
  assert.deepEqual([first.model.sizeX, first.model.sizeY, first.model.sizeZ], [34, 15, 13]);
  assert.throws(() => bakeModelInstance(scene, 0, 5), /instance/);
  assert.throws(() => bakeModelInstance(scene, 9), /not found/);
});

test('scenes without a graph place every model at the origin', () => {
  const scene = decodeVOXScene(buildSynthetic({ models: [cube(2), cube(2, 3)], nodes: [] }));
  const { parts } = flattenScene(scene);
  assert.equal(parts[0]!.model.voxels.length, 8);
  assert.ok(parts[0]!.model.voxels.every(v => v.i === 3));
});

test('cars.vox (installed sample) flattens to two vehicles', { skip: corpusSkip() }, () => {
  const scene = decodeVOXScene(readSample('cars.vox'));
  const { parts, instances } = flattenScene(scene);
  assert.equal(instances, 2);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.model.voxels.length, 3132 + 3235);
});

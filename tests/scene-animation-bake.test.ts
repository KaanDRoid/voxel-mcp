import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVOXScene } from '../src/scene.js';
import type { SceneNode, VoxDictionary } from '../src/scene.js';
import { collectInstances, flattenScene, bakeModelInstance, MAX_BAKE_INSTANCES, MAX_BAKE_VISITS, MAX_BAKE_DEPTH } from '../src/sceneBake.js';

function sceneWith(nodes: SceneNode[]) {
  const scene = createVOXScene([1, 2, 3].map(i => ({ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [{ x: 0, y: 0, z: 0, i }] })));
  scene.nodes = nodes;
  return scene;
}
const shape = (): SceneNode => ({ type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }] });
const transform = (frames: VoxDictionary[]): SceneNode => ({ type: 'nTRN', id: 0, attributes: {}, childId: 1, layerId: -1, frames });

test('direct inputs reject missing references and duplicate node ids', () => {
  assert.throws(() => collectInstances(sceneWith([transform([{}])])), /Missing scene node reference/);
  assert.throws(() => collectInstances(sceneWith([shape(), shape()])), /duplicate node id/i);
  const trn = transform([{}]);
  if (trn.type !== 'nTRN') throw new Error('fixture');
  trn.layerId = 99;
  assert.throws(() => collectInstances(sceneWith([trn, shape()])), /Missing scene layer reference/);
  for (const modelId of [-1, 3, 0.5]) {
    const shp = { type: 'nSHP' as const, id: 1, attributes: {}, models: [{ modelId: 0, attributes: { _f: '0' } }, { modelId, attributes: { _f: '10' } }] };
    assert.throws(() => collectInstances(sceneWith([shp])), /Missing scene model reference/);
  }
});

test('invalid rotations and translations on unselected keys are rejected', () => {
  for (const _r of ['0', '3', '128', 'NaN']) {
    assert.throws(() => collectInstances(sceneWith([transform([{}, { _f: '10', _r }]), shape()])), /Invalid packed rotation/);
  }
  assert.throws(() => collectInstances(sceneWith([transform([{}, { _f: '10', _t: 'not a vector' }]), shape()])), /Invalid translation/);
});

test('rootless, reachable and disconnected cycles fail with a controlled error', () => {
  const cycle: SceneNode = { type: 'nGRP', id: 2, attributes: {}, children: [2] };
  for (const nodes of [[cycle], [{ type: 'nGRP' as const, id: 0, attributes: {}, children: [2] }, cycle], [shape(), cycle]]) {
    assert.throws(() => collectInstances(sceneWith(nodes)), error => error instanceof Error && !(error instanceof RangeError) && /cyclic/i.test(error.message));
  }
});

test('excessively deep direct input fails without overflowing the JavaScript stack', () => {
  const nodes: SceneNode[] = Array.from({ length: 2000 }, (_, id) => ({ type: 'nGRP', id, attributes: {}, children: [id + 1] }));
  nodes.push({ ...shape(), id: 2000 });
  assert.throws(() => collectInstances(sceneWith(nodes)), error => error instanceof Error && !(error instanceof RangeError) && /deep|depth/i.test(error.message));
});

function sharedGraph(depth: number, leaf: SceneNode): SceneNode[] {
  return [...Array.from({ length: depth }, (_, id): SceneNode => ({ type: 'nGRP', id, attributes: {}, children: [id + 1, id + 1] })), { ...leaf, id: depth }];
}

test('shared exponential shape DAG is rejected before expanding instances', () => {
  let modelReads = 0;
  const leaf: SceneNode = { type: 'nSHP', id: 0, attributes: {}, models: [{ get modelId() { modelReads++; return 0; }, attributes: {} }] };
  for (const depth of [17, 60]) assert.throws(() => collectInstances(sceneWith(sharedGraph(depth, leaf))), /instance.*limit|limit.*instance/i);
  assert.ok(modelReads <= 4, 'preflight must reject before per-instance model reads');
});

test('shared exponential empty DAG is bounded by visits even with zero instances', () => {
  const leaf: SceneNode = { type: 'nGRP', id: 0, attributes: {}, children: [] };
  for (const depth of [18, 60]) assert.throws(() => collectInstances(sceneWith(sharedGraph(depth, leaf))), /visit.*limit|limit.*visit/i);
});

test('small shared DAGs retain each instance in depth-first document order', () => {
  const scene = sceneWith([
    { type: 'nGRP', id: 0, attributes: {}, children: [2, 3, 2] },
    { ...transform([{ _t: '2 0 0' }]), id: 2 },
    { ...transform([{ _t: '3 0 0' }]), id: 3 },
    shape(),
  ]);
  const instances = collectInstances(scene);
  assert.deepEqual(instances.map(i => i.translation), [[2, 0, 0], [3, 0, 0], [2, 0, 0]]);
  assert.deepEqual(instances.map(i => i.path), [[2], [3], [2]]);
});

test('instance, expanded visit and depth budgets accept their exact boundaries', () => {
  const flat = sceneWith([]);
  flat.models = Array.from({ length: MAX_BAKE_INSTANCES }, () => flat.models[0]!);
  assert.equal(collectInstances(flat).length, MAX_BAKE_INSTANCES);
  const leaf: SceneNode = { type: 'nGRP', id: 1, attributes: {}, children: [] };
  const broad = sceneWith([{ type: 'nGRP', id: 0, attributes: {}, children: Array.from({ length: MAX_BAKE_VISITS - 1 }, () => 1) }, leaf]);
  assert.deepEqual(collectInstances(broad), []);
  const chain: SceneNode[] = Array.from({ length: MAX_BAKE_DEPTH - 1 }, (_, id) => ({ type: 'nGRP', id, attributes: {}, children: [id + 1] }));
  chain.push({ ...shape(), id: MAX_BAKE_DEPTH - 1 });
  assert.equal(collectInstances(sceneWith(chain)).length, 1);
});

test('shape tracks use their earliest key before the first explicit timeline frame', () => {
  const scene = sceneWith([{ type: 'nSHP', id: 0, attributes: {}, models: [{ modelId: 2, attributes: { _f: '20' } }, { modelId: 1, attributes: { _f: '10' } }] }]);
  assert.equal(collectInstances(scene, { frame: 5 })[0]!.modelId, 1);
});

test('multiple roots share one aggregate instance and visit budget', () => {
  const scene = sceneWith(sharedGraph(13, shape()));
  scene.nodes.push({ type: 'nGRP', id: 100, attributes: {}, children: [1] });
  assert.throws(() => collectInstances(scene), /instance.*limit|limit.*instance/i);
  const empty = sceneWith(sharedGraph(15, { type: 'nGRP', id: 0, attributes: {}, children: [] }));
  empty.nodes.push({ type: 'nGRP', id: 100, attributes: {}, children: [1, 1] });
  assert.throws(() => collectInstances(empty), /visit.*limit|limit.*visit/i);
});

test('flat models without nodes obey the instance budget before output allocation', () => {
  const scene = sceneWith([]);
  scene.models = Array.from({ length: 10001 }, () => scene.models[0]!);
  assert.throws(() => collectInstances(scene), /instance.*limit|limit.*instance/i);
});

for (const kind of ['transform', 'shape'] as const) {
  for (const raw of ['-1', '1.5', 'NaN', '', ' 1', '1e1', '1000001', '9007199254740993']) {
    test(`${kind} rejects malformed _f ${JSON.stringify(raw)} even on an unselected key`, () => {
      const frames = [{ _f: '0' }, { _f: raw }];
      const node: SceneNode = kind === 'transform' ? transform(frames) : { type: 'nSHP', id: 0, attributes: {}, models: frames.map(attributes => ({ modelId: 0, attributes })) };
      assert.throws(() => collectInstances(sceneWith(kind === 'transform' ? [node, shape()] : [node])), /native frame index/i);
    });
  }
  test(`${kind} rejects duplicate explicit and positional timeline indices`, () => {
    const tracks: VoxDictionary[][] = [[{ _f: '0' }, { _f: '00' }], [{ _f: '1' }, {}]];
    for (const frames of tracks) {
      const node: SceneNode = kind === 'transform' ? transform(frames) : { type: 'nSHP', id: 0, attributes: {}, models: frames.map(attributes => ({ modelId: 0, attributes })) };
      assert.throws(() => collectInstances(sceneWith(kind === 'transform' ? [node, shape()] : [node])), /duplicate native frame index/i);
    }
  });
  test(`${kind} rejects empty and over-budget tracks`, () => {
    for (const frames of [[], Array.from({ length: 513 }, () => ({}))]) {
      const node: SceneNode = kind === 'transform' ? transform(frames) : { type: 'nSHP', id: 0, attributes: {}, models: frames.map(attributes => ({ modelId: 0, attributes })) };
      assert.throws(() => collectInstances(sceneWith(kind === 'transform' ? [node, shape()] : [node])), /keyframes/i);
    }
  });
}

test('shape swaps hold timeline keys including before-first, without mutating tracks', () => {
  const scene = sceneWith([transform([{ _f: '10', _t: '10 0 0' }, { _f: '20', _t: '20 0 0' }]),
    { type: 'nSHP', id: 1, attributes: {}, models: [20, 0, 10].map(f => ({ modelId: f / 10, attributes: { _f: String(f) } })) }]);
  const before = structuredClone(scene.nodes);
  for (const [frame, modelId] of [[0, 0], [5, 0], [10, 1], [15, 1], [20, 2], [99, 2]] as const) {
    const instance = collectInstances(scene, { frame })[0]!;
    assert.equal(instance.modelId, modelId);
    assert.equal(instance.translation[0], frame < 20 ? 10 : 20);
    assert.equal(flattenScene(scene, { frame }).parts[0]!.model.voxels[0]!.i, modelId + 1);
  }
  assert.deepEqual(scene.nodes, before);
});

test('missing _f falls back to each entry position for both track types', () => {
  const scene = sceneWith([transform([{}, { _t: '1 0 0' }, { _f: '10', _t: '10 0 0' }]),
    { type: 'nSHP', id: 1, attributes: {}, models: [{ modelId: 0, attributes: {} }, { modelId: 1, attributes: {} }, { modelId: 2, attributes: { _f: '10' } }] }]);
  for (const [frame, modelId, x] of [[0, 0, 0], [1, 1, 1], [5, 1, 1], [15, 2, 10]] as const) {
    const instance = collectInstances(scene, { frame })[0]!;
    assert.equal(instance.modelId, modelId);
    assert.equal(instance.translation[0], x);
  }
});

test('sparse transform baking holds the last timeline key, independent of track order', () => {
  const scene = sceneWith([transform([20, 0, 10].map(f => ({ _f: String(f), _t: `${f} 0 0` }))), shape()]);
  for (const [frame, x] of [[0, 0], [5, 0], [10, 10], [15, 10], [20, 20], [99, 20]] as const) {
    assert.deepEqual(collectInstances(scene, { frame })[0]!.translation, [x, 0, 0]);
    assert.deepEqual(flattenScene(scene, { frame }).parts[0]!.origin, [x, 0, 0]);
    assert.deepEqual(bakeModelInstance(scene, 0, 0, { frame }).origin, [x, 0, 0]);
  }
});

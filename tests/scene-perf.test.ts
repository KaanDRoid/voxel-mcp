import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './helpers/sceneHarness.js';
import { decodeVOXScene, encodeVOXScene } from '../src/scene.js';
import { buildSynthetic, cube, corpusSkip, samplePath, readSample } from './helpers/corpus.js';
import type { SynthNode } from './helpers/corpus.js';

/** Generous limits: the point is to catch quadratic behaviour and per-call re-decoding, not to benchmark. */
function manyNodes(objects: number): Buffer {
  const nodes: SynthNode[] = [{ kind: 'nTRN', id: 0, child: 1, frames: [{}] }, { kind: 'nGRP', id: 1, children: Array.from({ length: objects }, (_, i) => 2 + i * 2) }];
  for (let i = 0; i < objects; i++) {
    nodes.push({ kind: 'nTRN', id: 2 + i * 2, child: 3 + i * 2, layer: i % 32, frames: [{ _t: `${i} 0 0` }] });
    nodes.push({ kind: 'nSHP', id: 3 + i * 2, models: [{ modelId: 0 }] });
  }
  return buildSynthetic({ models: [cube(2)], nodes });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-perf-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

test('a scene with thousands of nodes decodes, encodes and edits in linear time', () => {
  const small = manyNodes(500), large = manyNodes(4000);
  const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
  const decodeSmall = time(() => decodeVOXScene(small));
  const decodeLarge = time(() => decodeVOXScene(large));
  const scene = decodeVOXScene(large);
  const encodeLarge = time(() => encodeVOXScene(scene));
  assert.ok(encodeVOXScene(scene).equals(large), 'large scene round-trips');
  assert.ok(decodeLarge < 2000 && encodeLarge < 2000, `decode ${decodeLarge.toFixed(0)} ms, encode ${encodeLarge.toFixed(0)} ms`);
  // 8x the nodes must not cost anywhere near 64x (quadratic) once warmed up.
  assert.ok(decodeLarge < Math.max(decodeSmall * 40, 200), `decode scaling ${decodeSmall.toFixed(1)} -> ${decodeLarge.toFixed(1)} ms`);
});

test('tool calls reuse the parsed scene instead of decoding on every call', async () => {
  const { call } = harness();
  const file = path.join(dir, 'many.vox'); fs.writeFileSync(file, manyNodes(500));
  const { sceneId } = await call('load_scene', { path: file });
  const started = performance.now();
  for (let i = 0; i < 50; i++) await call('get_scene_info', { sceneId });
  const perCall = (performance.now() - started) / 50;
  assert.ok(perCall < 50, `get_scene_info averaged ${perCall.toFixed(1)} ms`);
  const editStarted = performance.now();
  for (let i = 0; i < 20; i++) await call('set_scene_node', { sceneId, nodeId: 2 + i * 2, attributes: { _name: `n${i}` } });
  assert.ok((performance.now() - editStarted) / 20 < 100);
  const info = await call('get_scene_info', { sceneId });
  assert.equal(info.nodes.find((n: { id: number }) => n.id === 4).attributes._name, 'n1');
});

test('1000-node scene info and edits stay fast', async () => {
  const { call } = harness();
  const file = path.join(dir, 'k.vox'); fs.writeFileSync(file, manyNodes(500));
  const { sceneId } = await call('load_scene', { path: file });
  const t = performance.now();
  await call('get_scene_info', { sceneId });
  await call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'x' } });
  assert.ok(performance.now() - t < 1000);
});

test('menger.vox (installed sample, 160000 voxels) info call is fast after loading', { skip: corpusSkip() }, async () => {
  const { call } = harness();
  const { sceneId } = await call('load_scene', { path: samplePath('menger.vox') });
  const t = performance.now();
  await call('get_scene_info', { sceneId });
  assert.ok(performance.now() - t < 100, 'get_scene_info under 100 ms');
  assert.equal(decodeVOXScene(readSample('menger.vox')).models[0]!.voxels.length, 160000);
});

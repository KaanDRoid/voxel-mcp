import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVOXScene, encodeVOXScene, cloneScene } from '../src/scene.js';
import { buildDictionary, parseDictionary, buildMaterial, parseMaterial, parseRenderObject, buildRenderObject, parseIndexMap, buildNote, parseNote } from '../src/voxChunks.js';
import type { VoxDictionary } from '../src/voxChunks.js';
import { buildSynthetic, singleObject, cube, chunk, ints, str, dict, syntheticFixtures, voxFile, modelPair } from './helpers/corpus.js';
import type { VoxChunk } from '../src/vox.js';

function prng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const alphabet = ['a', 'b', '_', '0', ' ', '\u00e9', '\u4e2d', '-'];
const word = (r: () => number) => Array.from({ length: 1 + Math.floor(r() * 8) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');

test('property: random dictionaries survive parse and build exactly, in key order', () => {
  const r = prng(7);
  for (let n = 0; n < 200; n++) {
    const d: VoxDictionary = Object.create(null);
    for (let k = Math.floor(r() * 10); k > 0; k--) d['_' + word(r)] = word(r);
    const bytes = buildDictionary(d);
    const parsed = parseDictionary(bytes);
    assert.deepEqual(Object.entries(parsed), Object.entries(d));
    assert.ok(buildDictionary(parsed).equals(bytes));
  }
});

test('property: unknown render object keys are preserved through parse and build', () => {
  const r = prng(11);
  for (let n = 0; n < 100; n++) {
    const attrs: VoxDictionary = Object.create(null);
    attrs._type = '_inf';
    for (let k = Math.floor(r() * 6); k > 0; k--) attrs['_x' + word(r)] = word(r);
    const c: VoxChunk = { id: 'rOBJ', content: buildDictionary(attrs), children: [] };
    const obj = parseRenderObject(c);
    assert.equal(obj.type, '_inf');
    assert.deepEqual({ ...obj.attributes }, { ...attrs });
    assert.ok(buildRenderObject(obj).content.equals(c.content));
  }
});

test('material codec types the observed keys and keeps unknown ones', () => {
  const attrs = parseDictionary(buildDictionary({ _type: '_metal', _rough: '0.100000', _ior: '0.3', _ri: '1.3', _metal: '0.7', _weight: '1', _custom: 'abc', _g: 'not-a-number' }));
  const m = parseMaterial(attrs);
  assert.equal(m.type, '_metal'); assert.equal(m.rough, 0.1); assert.equal(m.metal, 0.7); assert.equal(m.ri, 1.3); assert.equal(m.weight, 1);
  assert.deepEqual({ ...m.extra }, { _custom: 'abc', _g: 'not-a-number' });
  assert.deepEqual(Object.entries(buildMaterial(m, attrs)), Object.entries(attrs));
  m.rough = 0.5;
  assert.equal(buildMaterial(m, attrs)._rough, '0.5');
  assert.equal(buildMaterial({ rough: 0.25, extra: {} })._rough, '0.25');
  assert.throws(() => buildMaterial({ rough: Number.NaN, extra: {} }));
});

test('NOTE and IMAP codecs validate their layout', () => {
  assert.deepEqual(parseNote(buildNote(['a', '', '\u00e9'])), ['a', '', '\u00e9']);
  assert.throws(() => parseNote({ id: 'NOTE', content: ints(5), children: [] }));
  assert.throws(() => parseIndexMap({ id: 'IMAP', content: Buffer.alloc(255), children: [] }));
});

test('editing one camera rewrites only that chunk and keeps unknown chunks and keys', () => {
  const base = buildSynthetic({ models: [cube(2)], nodes: singleObject() });
  const unknown = chunk('ABCD', Buffer.from([1, 2, 3]));
  const bytes = voxFile([...modelPair({ size: [2, 2, 2], voxels: [[0, 0, 0, 1]] }), unknown, chunk('rCAM', Buffer.concat([ints(3), dict({ _mode: 'pers', _future_key: 'kept' })]))], 200);
  const scene = decodeVOXScene(bytes);
  assert.deepEqual(scene.render.cameras.map(c => c.id), [3]);
  assert.ok(encodeVOXScene(scene).equals(bytes));
  scene.render.cameras[0]!.attributes._fov = '60';
  const out = decodeVOXScene(encodeVOXScene(scene));
  assert.deepEqual({ ...out.render.cameras[0]!.attributes }, { _mode: 'pers', _future_key: 'kept', _fov: '60' });
  assert.ok(out.document.main.children.some(c => c.id === 'ABCD' && c.content.equals(Buffer.from([1, 2, 3]))));
  void base;
});

test('removed, added and replaced render elements are written correctly', () => {
  const scene = decodeVOXScene(syntheticFixtures()['room.vox']!);
  scene.render.objects.splice(0, 1);
  delete scene.render.imap;
  scene.render.notes = ['one', 'two'];
  scene.render.meta = { _anim_range: '0 5' };
  scene.render.cameras.push({ id: 11, attributes: { _mode: 'ortho' } });
  const out = decodeVOXScene(encodeVOXScene(scene));
  assert.equal(out.render.objects.length, 14);
  assert.equal(out.render.imap, undefined);
  assert.deepEqual(out.render.notes, ['one', 'two']);
  assert.equal(out.render.meta?._anim_range, '0 5');
  assert.equal(out.render.cameras.at(-1)!.id, 11);
  assert.equal(out.document.main.children.filter(c => c.id === 'NOTE').length, 1);
});

test('cloneScene is an independent snapshot that still writes unchanged chunks verbatim', () => {
  const bytes = syntheticFixtures()['cars.vox']!;
  const scene = decodeVOXScene(bytes);
  const copy = cloneScene(scene);
  assert.ok(encodeVOXScene(copy).equals(bytes));
  copy.nodes[2]!.attributes._name = 'changed';
  copy.render.objects[0]!.attributes._diffuse = '9';
  assert.equal(scene.nodes[2]!.attributes._name, undefined);
  assert.ok(encodeVOXScene(scene).equals(bytes));
  assert.ok(!encodeVOXScene(copy).equals(bytes));
});

test('strict mode rejects malformed typed chunks; lenient mode skips them with a warning and keeps their bytes', () => {
  const badNote = chunk('NOTE', ints(5));
  const badUtf8 = chunk('LAYR', Buffer.concat([ints(0), ints(1), ints(5), Buffer.from('_name'), ints(2), Buffer.from([0xc3, 0x28]), ints(-1)]));
  const bytes = voxFile([...modelPair({ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }), badUtf8, badNote], 200);
  assert.throws(() => decodeVOXScene(bytes), /UTF-8|Invalid|Truncated/);
  const warnings: string[] = [];
  const scene = decodeVOXScene(bytes, { lenient: true, warnings });
  assert.ok(warnings.some(w => /UTF-8/.test(w)), warnings.join('|'));
  assert.ok(warnings.some(w => /NOTE/.test(w)), warnings.join('|'));
  assert.equal(scene.layers[0]!.attributes._name, '\ufffd(');
  assert.equal(scene.render.notes, undefined);
  assert.ok(encodeVOXScene(scene).includes(badNote));
  assert.deepEqual(scene.warnings, warnings);
  void str;
});

test('critical chunk errors stay fatal in lenient mode', () => {
  const file = (xyzi: Buffer, size = ints(2, 2, 2)) => voxFile([chunk('SIZE', size), chunk('XYZI', xyzi)], 150);
  assert.throws(() => decodeVOXScene(file(Buffer.from([1, 0, 0, 0, 5, 0, 0, 1])), { lenient: true }), /outside/);
  assert.throws(() => decodeVOXScene(file(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])), { lenient: true }), /palette index/);
  assert.throws(() => decodeVOXScene(file(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1])), { lenient: true }), /XYZI count/);
  assert.throws(() => decodeVOXScene(file(Buffer.from([0, 0, 0, 0]), ints(0, 1, 1)), { lenient: true }), /dimensions/);
  assert.throws(() => decodeVOXScene(Buffer.from('nope'), { lenient: true }));
});

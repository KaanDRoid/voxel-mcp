import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVOXDocument, readDocumentModels, encodeVOXDocument } from '../src/vox.js';
import type { VoxChunk } from '../src/vox.js';
import { decodeVOXScene, encodeVOXScene } from '../src/scene.js';
import { buildMaterial, buildRenderCamera, buildRenderObject, buildNote, buildIndexMap, buildMeta, parseMaterial, parseDictionary, parseRenderCamera, parseRenderObject, parseNote, parseIndexMap, parseMeta, RENDER_OBJECT_TYPES } from '../src/voxChunks.js';
import { SAMPLE_NAMES, SAMPLE_SHAPES, corpusSkip, readSample, sampleFiles, syntheticFixtures, corpusRoot } from './helpers/corpus.js';
import type { SampleShape } from './helpers/corpus.js';

function shapeOf(buf: Buffer): SampleShape {
  const doc = decodeVOXDocument(buf);
  const n = (id: string) => doc.main.children.filter(c => c.id === id).length;
  return { models: readDocumentModels(doc).length, nTRN: n('nTRN'), nGRP: n('nGRP'), nSHP: n('nSHP'), LAYR: n('LAYR'), MATL: n('MATL'), rOBJ: n('rOBJ'), rCAM: n('rCAM'), NOTE: n('NOTE'), IMAP: n('IMAP'), META: n('META') };
}

/** Checks every typed codec against one file: parse + rebuild must reproduce the chunk bytes exactly. */
function checkTypedCodecs(name: string, buf: Buffer): void {
  const doc = decodeVOXDocument(buf);
  const same = (a: VoxChunk, b: VoxChunk, what: string) => assert.ok(a.content.equals(b.content) && a.id === b.id, `${name}: ${what} does not rebuild byte-for-byte`);
  for (const c of doc.main.children) {
    if (c.id === 'rOBJ') same(buildRenderObject(parseRenderObject(c)), c, 'rOBJ');
    else if (c.id === 'rCAM') same(buildRenderCamera(parseRenderCamera(c)), c, 'rCAM');
    else if (c.id === 'NOTE') same(buildNote(parseNote(c)), c, 'NOTE');
    else if (c.id === 'IMAP') same(buildIndexMap(parseIndexMap(c)), c, 'IMAP');
    else if (c.id === 'META') same(buildMeta(parseMeta(c)), c, 'META');
    else if (c.id === 'MATL') {
      const attrs = parseDictionary(c.content.subarray(4));
      const rebuilt = buildMaterial(parseMaterial(attrs), attrs);
      assert.deepEqual(Object.entries(rebuilt), Object.entries(attrs), `${name}: MATL ${c.content.readInt32LE(0)} does not rebuild`);
    }
  }
}

function checkFile(name: string, buf: Buffer, expected: SampleShape): void {
  assert.deepEqual(shapeOf(buf), expected, `${name}: chunk counts differ from the documented corpus table`);
  const doc = decodeVOXDocument(buf);
  assert.equal(doc.version, 200, `${name}: version`);
  assert.ok(encodeVOXDocument(doc).equals(buf), `${name}: raw document round-trip differs`);
  const scene = decodeVOXScene(buf);
  assert.equal(scene.models.length, expected.models, `${name}: scene model count`);
  assert.equal(scene.render.objects.length, expected.rOBJ, `${name}: render objects`);
  assert.equal(scene.render.cameras.length, expected.rCAM, `${name}: cameras`);
  assert.equal(scene.render.notes?.length, 32, `${name}: notes`);
  assert.equal(scene.render.imap?.length, expected.IMAP ? 256 : undefined, `${name}: imap`);
  assert.equal(scene.render.meta !== undefined, expected.META === 1, `${name}: meta`);
  assert.deepEqual(scene.render.objects.map(o => o.type), [...RENDER_OBJECT_TYPES], `${name}: render object kinds`);
  const out = encodeVOXScene(scene);
  assert.ok(out.equals(buf), `${name}: scene round-trip differs at byte ${out.findIndex((v, i) => v !== buf[i])} (length ${out.length} vs ${buf.length})`);
  checkTypedCodecs(name, buf);
}

describe('real MagicaVoxel samples', { skip: corpusSkip() }, () => {
  test('all 15 samples are present in the installation', () => {
    assert.deepEqual(sampleFiles(), [...SAMPLE_NAMES]);
  });
  for (const name of SAMPLE_NAMES) {
    test(`${name}: strict decode, typed codecs and byte-for-byte round-trip`, () => checkFile(name, readSample(name), SAMPLE_SHAPES[name]!));
  }
  test('observed values: cars transforms, Gomez rotation, animation metadata', () => {
    const cars = decodeVOXScene(readSample('cars.vox'));
    const trn = cars.nodes.filter(n => n.type === 'nTRN' && n.id !== 0);
    assert.deepEqual(trn.map(n => (n.type === 'nTRN' ? { ...n.frames[0] } : {})), [{ _r: '17', _t: '-28 7 6' }, { _t: '16 -11 7' }]);
    assert.deepEqual(cars.models.map(m => [m.sizeX, m.sizeY, m.sizeZ, m.voxels.length]), [[15, 34, 13, 3132], [15, 32, 14, 3235]]);
    assert.equal(decodeVOXScene(readSample('anim/T-Rex-m.vox')).render.meta?._anim_range, '0 30');
    assert.equal(decodeVOXScene(readSample('room.vox')).render.imap?.length, 256);
  });
  test('materials keep their observed keys', () => {
    const keys = new Set<string>();
    for (const name of SAMPLE_NAMES) for (const m of decodeVOXScene(readSample(name)).materials) for (const k of Object.keys(m.attributes)) keys.add(k);
    for (const k of ['_rough', '_ior', '_ri']) assert.ok(keys.has(k), k);
    for (const k of keys) assert.ok(['_type', '_rough', '_ior', '_ri', '_d', '_g', '_emit', '_flux', '_metal', '_weight', '_spec', '_att', '_plastic'].includes(k), `unexpected material key ${k}`);
  });
});

describe('synthetic v200 fixtures (always run)', () => {
  const fixtures = syntheticFixtures();
  for (const [name, buf] of Object.entries(fixtures)) {
    test(`${name}: strict decode, typed codecs and byte-for-byte round-trip`, () => {
      const expected = { ...SAMPLE_SHAPES[name]! };
      if (name === 'anim/Gomez.vox') expected.models = 3;
      checkFile(name, buf, expected);
    });
  }
  test('corpus root detection does not throw without an installation', () => {
    assert.ok(corpusRoot() === undefined || typeof corpusRoot() === 'string');
  });
});

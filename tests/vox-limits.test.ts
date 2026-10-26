import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeVOXDocument, readDocumentModels, MAX_FILE_VOXELS } from '../src/vox.js';

function chunk(id: string, content: Buffer, children: Buffer[] = []): Buffer {
  const header = Buffer.alloc(12);
  header.write(id, 0, 4, 'latin1');
  header.writeUInt32LE(content.length, 4);
  header.writeUInt32LE(children.reduce((n, c) => n + c.length, 0), 8);
  return Buffer.concat([header, content, ...children]);
}
function file(n: number): Buffer {
  const size = Buffer.alloc(12); size.writeUInt32LE(256, 0); size.writeUInt32LE(256, 4); size.writeUInt32LE(256, 8);
  const xyzi = Buffer.alloc(4 + n * 4); xyzi.writeUInt32LE(n, 0);
  for (let i = 0; i < n; i++) { xyzi[4 + i * 4] = i & 255; xyzi[5 + i * 4] = (i >> 8) & 255; xyzi[6 + i * 4] = (i >> 16) & 255; xyzi[7 + i * 4] = 1; }
  const head = Buffer.alloc(8); head.write('VOX ', 0, 4, 'latin1'); head.writeUInt32LE(150, 4);
  return Buffer.concat([head, chunk('MAIN', Buffer.alloc(0), [chunk('SIZE', size), chunk('XYZI', xyzi)])]);
}

test('files above the voxel cap are rejected before voxel objects are allocated', () => {
  const doc = decodeVOXDocument(file(MAX_FILE_VOXELS + 1));
  assert.throws(() => readDocumentModels(doc), /supported limit/);
});

test('dense duplicate detection handles a large valid model quickly', () => {
  const started = Date.now();
  assert.equal(readDocumentModels(decodeVOXDocument(file(300_000)))[0]!.voxels.length, 300_000);
  assert.ok(Date.now() - started < 5000);
});

test('duplicate coordinates are still rejected', () => {
  const bytes = file(2);
  bytes.writeUInt8(0, bytes.length - 4); bytes.writeUInt8(0, bytes.length - 3); bytes.writeUInt8(0, bytes.length - 2);
  bytes.writeUInt8(0, bytes.length - 8); bytes.writeUInt8(0, bytes.length - 7); bytes.writeUInt8(0, bytes.length - 6);
  assert.throws(() => readDocumentModels(decodeVOXDocument(bytes)), /Duplicate/);
});

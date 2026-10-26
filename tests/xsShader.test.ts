import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { validateXsSource, parseXsHeader, listShaders, installShaderDir, readInstalledShader } from '../src/xsShader.js';

export const HEAD = (args = '') => `// xs_begin\n// author : 'tester'\n${args}// xs_end\n`;
const BODY = 'float map( vec3 v ) {\n  return i_color_index;\n}\n';
const ARG = (v: string, value = '6', range = '3 64') => `// arg : { var = '${v}' name = 'Name' value = '${value}' range = '${range}' step = '1' precision = '0' }\n`;

test('header parser reads author, src and arg fields with tabs and CRLF line endings', () => {
  const src = `// xs_begin\r\n// author : 'someone'\r\n// src : 'https://example.com/a'\r\n// arg : { var = 'm_a'\tname = 'A'\tvalue = '0.5' range = '0.0 1.0' step = '0.05'\tprecision = '2' }\r\n// xs_end\r\n${BODY}`;
  const errors: string[] = [], warnings: string[] = [];
  const h = parseXsHeader(src, errors, warnings);
  assert.deepEqual(errors, []);
  assert.equal(h.author, 'someone');
  assert.equal(h.src, 'https://example.com/a');
  assert.deepEqual(h.args, [{ var: 'm_a', name: 'A', value: 0.5, range: [0, 1], step: 0.05, precision: 2 }]);
});

test('validation accepts a minimal shader and reports it evaluable', () => {
  const v = validateXsSource(HEAD() + BODY);
  assert.deepEqual(v.errors, []);
  assert.equal(v.valid, true);
  assert.equal(v.hasMap, true);
  assert.equal(v.evaluable, true);
});

test('validation reports structural problems with clear messages', () => {
  const cases: Array<[string, RegExp]> = [
    [BODY, /xs_begin/],
    ['// xs_begin\n' + BODY, /xs_end/],
    [HEAD() + 'float other( vec3 v ) { return 0.0; }\n', /map/],
    [HEAD() + 'float map( vec3 v ) { return 0.0;\n', /braces/],
    [HEAD(ARG('m_a', 'x')) + BODY, /not a number/],
    [HEAD(ARG('m_a', '5', '9 3')) + BODY, /minimum exceeds/],
    [HEAD(ARG('m_a') + ARG('m_a')) + BODY, /duplicate arg/],
    [HEAD("// arg : { var = 'm_a' name = 'A' }\n") + BODY, /missing 'value'/],
    [HEAD("// arg : { var = '1bad' name = 'A' value = '1' range = '0 2' step = '1' precision = '0' }\n") + BODY, /invalid variable name/],
    [HEAD('// author : unquoted\n') + BODY, /quoted/],
    [HEAD("// arg : { var = 'm_a' name = 'A' value = '1' range = '0 2' step = '0' precision = '0' }\n") + BODY, /step/],
  ];
  for (const [src, re] of cases) {
    const v = validateXsSource(src);
    assert.equal(v.valid, false, src);
    assert.match(v.errors.join('\n'), re, src);
  }
});

test('validation warns about undeclared and unused args without failing', () => {
  const v = validateXsSource(HEAD(ARG('m_unused')) + 'float map( vec3 v ) {\n  return m_missing;\n}\n');
  assert.equal(v.valid, true);
  assert.match(v.warnings.join('\n'), /m_missing.*not declared/);
  assert.match(v.warnings.join('\n'), /m_unused.*never used/);
});

test('unsupported GLSL is valid but reported as not evaluable', () => {
  const v = validateXsSource(HEAD() + 'float map( vec3 v ) {\n  mat3 m = mat3(1.0);\n  return 0.0;\n}\n');
  assert.equal(v.valid, true);
  assert.equal(v.evaluable, false);
  assert.ok(v.evaluableReason);
});

test('workspace listing only returns xs shaders and flags invalid ones', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'xs-list-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.txt'), HEAD(ARG('m_a')) + 'float map( vec3 v ) { return m_a; }\n');
    fs.writeFileSync(path.join(dir, 'bad.txt'), '// xs_begin\n// arg : nonsense\n// xs_end\n' + BODY);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'just notes');
    const list = listShaders(dir, 'workspace');
    assert.deepEqual(list.map(s => [s.name, s.valid]), [['bad', false], ['good', true]]);
    assert.deepEqual(list[1]!.args, ['m_a']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installed shader names are restricted to the shader folder', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'xs-inst-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.txt'), HEAD() + BODY);
    assert.match(readInstalledShader(dir, 'ok'), /xs_begin/);
    for (const bad of ['../ok', 'a/b', 'a\\b', '', 'x'.repeat(65), 'ok.txt']) assert.throws(() => readInstalledShader(dir, bad), /name|not found/i);
    assert.throws(() => readInstalledShader(dir, 'missing'), /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Corpus test: the 7 shaders that ship with MagicaVoxel (read in place, never copied).
const home = process.env.MAGICAVOXEL_HOME ?? (process.env.MAGICAVOXEL_PATH ? path.dirname(process.env.MAGICAVOXEL_PATH) : undefined);
const shaderDir = home ? installShaderDir(path.join(home, 'MagicaVoxel.exe')) : null;
test('shipped shaders parse with the expected arg lists', { skip: shaderDir ? false : 'MagicaVoxel install not available' }, () => {
  const expected: Record<string, string[]> = {
    gear: ['m_teeth', 'm_inner'], mandelbulb: ['m_degree'], poly: ['m_side', 'm_angle'], round: ['m_radius'],
    sphere: [], stair: ['m_width', 'm_rise', 'm_thick', 'm_dir'], torus: ['m_radius'],
  };
  for (const [name, args] of Object.entries(expected)) {
    const v = validateXsSource(readInstalledShader(shaderDir!, name));
    assert.deepEqual(v.errors, [], name);
    assert.equal(v.valid, true, name);
    assert.deepEqual(v.header.args.map(a => a.var), args, name);
    assert.equal(v.evaluable, true, `${name}: ${v.evaluableReason}`);
  }
  assert.equal(validateXsSource(readInstalledShader(shaderDir!, 'gear')).header.args[1]!.value, 0.5);
  assert.equal(validateXsSource(readInstalledShader(shaderDir!, 'round')).header.src?.startsWith('https://'), true);
});

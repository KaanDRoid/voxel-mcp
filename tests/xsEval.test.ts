import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { compileXs, runXsOnVolume, XsRuntimeError, XsSyntaxError, XS_LIMITS } from '../src/xsEval.js';
import { validateXsSource, installShaderDir, readInstalledShader } from '../src/xsShader.js';
import { fillSphere } from '../src/model.js';
import { generateXsTemplate, XS_TEMPLATE_KINDS } from '../src/xsTemplates.js';

const HEAD = (args = '') => `// xs_begin\n${args}// xs_end\n`;
const ARG = (v: string, value: string, range = '0 64') => `// arg : { var = '${v}' name = '${v}' value = '${value}' range = '${range}' step = '1' precision = '0' }\n`;

interface At { size?: [number, number, number]; args?: Record<string, number>; color?: number; sels?: number[]; voxel?: (x: number, y: number, z: number) => number }
/** Compile a shader and evaluate map() at one position. */
function evalAt(source: string, pos: [number, number, number], o: At = {}): number {
  const v = validateXsSource(source);
  assert.deepEqual(v.errors, []);
  const args: Record<string, number> = {};
  for (const a of v.header.args) args[a.var] = a.value;
  Object.assign(args, o.args);
  const program = compileXs(source, v.header.args.map(a => a.var));
  return program.instantiate({ volumeSize: o.size ?? [16, 16, 16], colorIndex: o.color ?? 1, selections: o.sels ?? [o.color ?? 1], args, ...(o.voxel ? { voxelAt: o.voxel } : {}) })(...pos);
}
const body = (code: string, args = '') => `${HEAD(args)}${code}`;

test('arithmetic, vectors, swizzles and built-in functions behave like GLSL', () => {
  const t = (expr: string, expected: number) => assert.ok(Math.abs(evalAt(body(`float map( vec3 v ) { return ${expr}; }`), [0, 0, 0]) - expected) < 1e-9, `${expr} => ${expected}`);
  t('1.0 + 2.0 * 3.0', 7);
  t('mod(-1.0, 3.0)', 2); // GLSL mod is floored
  t('fract(-0.25)', 0.75);
  t('length(vec3(2.0, 3.0, 6.0))', 7);
  t('dot(vec3(1.0, 2.0, 3.0), vec3(4.0, 5.0, 6.0))', 32);
  t('cross(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0)).z', 1);
  t('vec3(1.0, 2.0, 3.0).zyx.x', 3);
  t('vec4(vec2(1.0, 2.0), 3.0, 4.0).w', 4);
  t('vec3(0.5).y', 0.5);
  t('smoothstep(0.0, 1.0, 0.5)', 0.5);
  t('step(1.0, 1.0) + step(1.0, 0.5)', 1);
  t('clamp(5.0, 0.0, 2.0)', 2);
  t('mix(2.0, 4.0, 0.25)', 2.5);
  t('atan(1.0, 1.0)', Math.PI / 4);
  t('pow(2.0, 10.0)', 1024);
  t('float(3) / 2.0', 1.5);
  t('(1.0 < 2.0 && 3.0 >= 3.0) ? 10.0 : 20.0', 10);
  t('min(vec3(1.0, 5.0, 3.0), 2.0).y', 2);
  t('max(abs(vec2(-3.0, 1.0) - 1.0).x, 0.0)', 4);
  t('normalize(vec2(3.0, 4.0)).x', 0.6);
});

test('statements: locals, compound assignment, swizzle assignment, loops, user functions', () => {
  const src = body(`
const float K = 2.0;
vec3 twice( vec3 p, float n ) { return p * n * K; }
float map( vec3 v ) {
  float total = 0.0;
  for ( int i = 0; i < 5; i++ ) {
    if ( i == 3 ) { continue; }
    total += float( i );
  }
  vec3 p = twice( vec3( 1.0, 2.0, 3.0 ), 1.0 );
  p.xy = vec2( p.y, p.x );
  p.z *= 0.5;
  int k = 7;
  k /= 2;
  int w = 0;
  while ( w < 10 ) { w += 3; if ( w > 5 ) { break; } }
  return total * 1000.0 + p.x * 100.0 + p.y * 10.0 + p.z + float( k ) * 0.0 + float( w ) * 0.0;
}`);
  // total = 0+1+2+4 = 7 ; p = (2,4,6) -> swap -> (4,2,6) -> z = 3
  assert.equal(evalAt(src, [0, 0, 0]), 7000 + 400 + 20 + 3);
});

test('integer variables truncate and value semantics copy vectors', () => {
  assert.equal(evalAt(body('float map( vec3 v ) { int k = 7; k /= 2; return float( k ); }'), [0, 0, 0]), 3);
  assert.equal(evalAt(body('float map( vec3 v ) { vec3 a = vec3( 1.0 ); vec3 b = a; b.x = 5.0; return a.x; }'), [0, 0, 0]), 1);
});

test('built-in arguments, voxel(), color_sel() and header args are available', () => {
  const src = body('float map( vec3 v ) { return i_volume_size.z + i_color_index * 100.0 + float( i_num_color_sels ) * 10000.0 + m_extra * 1000000.0 + voxel( v ) * 0.5 + color_sel( 1.7 ) * 0.001; }', ARG('m_extra', '1'));
  const got = evalAt(src, [1.5, 2.5, 3.5], { size: [8, 8, 8], color: 3, sels: [4, 5, 6], voxel: (x, y, z) => (x === 1 && y === 2 && z === 3 ? 9 : 0) });
  assert.ok(Math.abs(got - (8 + 300 + 30000 + 1000000 + 4.5 + 0.005)) < 1e-6, String(got));
});

test('syntax outside the supported subset is rejected with a line number', () => {
  const bad = (code: string, re: RegExp) => assert.throws(() => compileXs(body(code)), (e: unknown) => e instanceof XsSyntaxError && re.test(e.message), code);
  bad('uniform float u;\nfloat map( vec3 v ) { return 0.0; }', /uniform/);
  bad('#define X 1\nfloat map( vec3 v ) { return 0.0; }', /preprocessor/);
  bad('float map( vec3 v ) { return texture( v ); }', /unsupported function 'texture'/);
  bad('float map( vec3 v ) { mat3 m; return 0.0; }', /mat3|identifier|keyword/);
  bad('float map( vec3 v ) { return undefined_name; }', /undefined identifier/);
  bad('float f( float x ) { return f( x ); }\nfloat map( vec3 v ) { return f( 1.0 ); }', /unsupported function 'f'/);
  bad('float map( vec3 v ) { float a[2]; return 0.0; }', /arrays/);
  bad('float map( vec3 v ) { i_color_index = 1.0; return 0.0; }', /cannot assign/);
  bad('float map( vec3 v ) { return v.constructor; }', /selector/);
  bad('float map( vec3 v ) { return 1.0 }', /expected ';'/);
  bad('float other( vec3 v ) { return 0.0; }', /no map/);
  bad('float map( float v ) { return 0.0; }', /signature/);
  bad('float map( vec3 v ) { float x = 1.0; float x = 2.0; return x; }', /already declared/);
  bad('float map( vec3 v ) { return __proto__; }', /undefined identifier/);
  bad('float map( vec3 v ) {\n  return 0.0;\n  @\n}', /line 5: unexpected character/);
});

test('runtime errors: type mismatches surface as XsRuntimeError with context', () => {
  const run = (expr: string) => evalAt(body(`float map( vec3 v ) { return ${expr}; }`), [0, 0, 0]);
  assert.throws(() => run('vec3( 1.0, 2.0 ).x'), XsRuntimeError);
  assert.throws(() => run('vec2( 1.0 ) + vec3( 1.0 )'), /size mismatch/);
  assert.throws(() => run('vec2( 1.0 ).z'), /out of range/);
  assert.throws(() => run('length( 1.0 ).x'), /scalar/);
});

test('resource limits: endless loops, nested loops and deep nesting are stopped', () => {
  assert.throws(() => evalAt(body('float map( vec3 v ) { while ( true ) { } return 0.0; }'), [0, 0, 0]), /loop iteration limit/);
  assert.throws(() => evalAt(body('float map( vec3 v ) { for ( int i = 0; i < 1000000; i++ ) { } return 0.0; }'), [0, 0, 0]), /loop iteration limit/);
  assert.throws(() => evalAt(body('float map( vec3 v ) { float s = 0.0; for ( int i = 0; i < 4000; i++ ) { for ( int j = 0; j < 4000; j++ ) { s += 1.0; } } return s; }'), [0, 0, 0]), /step budget/);
  const deep = '('.repeat(XS_LIMITS.maxDepth + 10) + '1.0' + ')'.repeat(XS_LIMITS.maxDepth + 10);
  assert.throws(() => compileXs(body(`float map( vec3 v ) { return ${deep}; }`)), /too deep/);
  assert.throws(() => compileXs('x'.repeat(XS_LIMITS.maxSourceBytes + 1)), /too large/);
  assert.throws(() => compileXs(body(`float map( vec3 v ) { return ${'1.0+'.repeat(12000)}1.0; }`)), /too many tokens/);
});

test('wall-clock limit aborts a long volume run', () => {
  const program = compileXs(body('float map( vec3 v ) { float s = 0.0; for ( int i = 0; i < 200; i++ ) { s += sin( s + v.x ); } return s; }'));
  const model = { sizeX: 128, sizeY: 128, sizeZ: 128, voxels: [] };
  assert.throws(() => runXsOnVolume(program, model, { args: {}, colorIndex: 1, selections: [1], mode: 'replace', timeLimitMs: 20 }, 2_000_000), /time limit/);
});

test('shader text cannot reach host objects', () => {
  for (const code of ['return this;', 'return globalThis;', 'return process;', 'return require;', 'return constructor;', 'return v.__proto__;']) {
    assert.throws(() => evalAt(body(`float map( vec3 v ) { ${code} }`), [0, 0, 0]), /undefined identifier|selector|keyword|unexpected/, code);
  }
});

// ------------------------------------------------------------------ hand-computed expectations on synthetic shaders
const SPHERE = body('float map( vec3 v ) {\n  vec3 h = i_volume_size * 0.5;\n  vec3 d = ( v - h ) / h;\n  return i_color_index * step( length( d ), 1.0 );\n}');
const ROUND = body('float map( vec3 v ) {\n  vec3 h = i_volume_size * 0.5;\n  vec3 q = abs( v - h ) - h + m_radius;\n  float d = length( max( q, 0.0 ) ) + min( max( q.x, max( q.y, q.z ) ), 0.0 );\n  if ( d < m_radius ) { return i_color_index; }\n  return 0.0;\n}', ARG('m_radius', '5'));
const TORUS = body('float map( vec3 v ) {\n  vec3 p = v - i_volume_size * 0.5;\n  float big = min( i_volume_size.x, i_volume_size.y ) * 0.5;\n  float dist = length( vec2( length( p.xy ) - big + m_radius, p.z ) ) - m_radius;\n  if ( dist > 0.5 ) { return 0.0; }\n  float band = i_volume_size.x / float( i_num_color_sels );\n  return color_sel( v.x / band );\n}', ARG('m_radius', '3'));
const STAIR = body('float map( vec3 v ) {\n  float n = floor( v.x / m_width );\n  float top = i_volume_size.z - m_rise * n;\n  if ( v.z > top || v.z < top - m_thick ) { return 0.0; }\n  return color_sel( mod( n + 0.5, float( i_num_color_sels ) ) );\n}', ARG('m_width', '1') + ARG('m_rise', '1') + ARG('m_thick', '1'));
const POLY = body('float map( vec3 v ) {\n  const float PI = 3.1415926;\n  vec2 u = ( v - i_volume_size * 0.5 ).xy;\n  float angle = PI * 2.0 / max( floor( m_side ), 3.0 );\n  float t = min( i_volume_size.x, i_volume_size.y ) * 0.5;\n  float r = length( u );\n  float theta = atan( u.y, u.x ) + PI;\n  r *= cos( angle * abs( fract( theta / angle ) - 0.5 ) );\n  t *= cos( angle * 0.5 );\n  return i_color_index * step( r, t );\n}', ARG('m_side', '3'));
const GEAR = body('float map( vec3 v ) {\n  vec3 p = v - i_volume_size * 0.5;\n  p.z = 1.0;\n  float r = 0.12 * min( i_volume_size.x, i_volume_size.y );\n  float R = length( p );\n  float a = atan( p.y, p.x );\n  float f = smoothstep( -0.5, 1.0, cos( a * m_teeth ) ) * r + r * 3.0;\n  float hole = step( r * 4.0 * m_inner, R );\n  return hole * ( 1.0 - step( f, R ) ) * i_color_index;\n}', ARG('m_teeth', '6') + ARG('m_inner', '0.5', '0 1'));
const BULB = body('vec3 powern( vec3 v, float n ) {\n  float r = length( v );\n  float phi = atan( v.y, v.x );\n  float theta = atan( length( v.xy ), v.z );\n  r = pow( r, n ); phi *= n; theta *= n;\n  return r * vec3( sin( theta ) * vec2( cos( phi ), sin( phi ) ), cos( theta ) );\n}\nfloat map( vec3 v ) {\n  float n = max( m_degree, 4.0 );\n  vec3 center = i_volume_size * 0.5;\n  float size = min( min( center.x, center.y ), center.z );\n  vec3 u = ( v - center ) / size * 1.1;\n  for ( int i = 0; i < 8; i++ ) { u = powern( u, n ) + u; }\n  return i_color_index * step( length( u ), 2.0 );\n}', ARG('m_degree', '3'));

test('sphere shader matches fill_sphere exactly on an even-sized volume', () => {
  for (const size of [8, 16, 32]) {
    const program = compileXs(SPHERE);
    const model = { sizeX: size, sizeY: size, sizeZ: size, voxels: [] as { x: number; y: number; z: number; i: number }[] };
    const result = runXsOnVolume(program, model, { args: {}, colorIndex: 7, selections: [7], mode: 'replace', timeLimitMs: 20000 }, 2_000_000);
    const reference = { sizeX: size, sizeY: size, sizeZ: size, voxels: [] as { x: number; y: number; z: number; i: number }[] };
    fillSphere(reference, size / 2 - 0.5, size / 2 - 0.5, size / 2 - 0.5, size / 2, 7);
    const key = (v: { x: number; y: number; z: number; i: number }) => `${v.x},${v.y},${v.z},${v.i}`;
    assert.deepEqual(result.voxels.map(key).sort(), reference.voxels.map(key).sort(), `size ${size}`);
    assert.ok(result.filled > 0);
  }
});

test('rounded box: hand-computed voxels (size 8, radius 2)', () => {
  const at = (p: [number, number, number]) => evalAt(ROUND, p, { size: [8, 8, 8], args: { m_radius: 2 }, color: 9 });
  assert.equal(at([3.5, 3.5, 3.5]), 9); // center
  assert.equal(at([0.5, 3.5, 3.5]), 9); // face: max(q) = 1.5 < 2
  assert.equal(at([0.5, 1.5, 3.5]), 9); // near edge: |(1.5, 0.5)| = 1.58 < 2
  assert.equal(at([0.5, 0.5, 3.5]), 0); // edge: |(1.5, 1.5)| = 2.12 > 2
  assert.equal(at([0.5, 0.5, 0.5]), 0); // corner: 2.6 > 2
});

test('torus: hand-computed voxels and color_sel banding (size 16, tube 3, 2 colors)', () => {
  const at = (p: [number, number, number]) => evalAt(TORUS, p, { args: { m_radius: 3 }, sels: [11, 12] });
  assert.equal(at([1.5, 8.5, 8.5]), 11); // |(6.52-8+3, 0.5)| - 3 < 0.5, band 0
  assert.equal(at([12.5, 8.5, 8.5]), 12); // band floor(12.5 / 8) = 1
  assert.equal(at([8.5, 8.5, 8.5]), 0); // hole: |(-4.29, 0.5)| - 3 = 1.3 > 0.5
});

test('stair: hand-computed steps and color cycling (size 8, width 2, rise 1, thick 1)', () => {
  const at = (p: [number, number, number]) => evalAt(STAIR, p, { size: [8, 8, 8], args: { m_width: 2, m_rise: 1, m_thick: 1 }, sels: [5, 6] });
  assert.equal(at([0.5, 0.5, 7.5]), 5); // n=0 top=8
  assert.equal(at([0.5, 0.5, 6.5]), 0); // below top-thick = 7
  assert.equal(at([2.5, 0.5, 6.5]), 6); // n=1 top=7, color_sel(1.5) -> index 1
  assert.equal(at([2.5, 0.5, 7.5]), 0); // above top
  assert.equal(at([4.5, 0.5, 5.5]), 5); // n=2 top=6, mod(2.5, 2) = 0.5 -> index 0
});

test('polygon: hand-computed voxels (square, size 16)', () => {
  const at = (p: [number, number, number]) => evalAt(POLY, p, { args: { m_side: 4 }, color: 4 });
  assert.equal(at([8.5, 8.5, 8.5]), 4);
  assert.equal(at([0.5, 0.5, 8.5]), 0);
  assert.equal(at([15.5, 15.5, 0.5]), 0);
});

test('gear: hand-computed voxels (size 16, 6 teeth, inner 0.5)', () => {
  const at = (p: [number, number, number]) => evalAt(GEAR, p, { color: 3 });
  assert.equal(at([8.5, 8.5, 2.5]), 0); // hole: R = 0.71 < 3.84
  assert.equal(at([13.5, 8.5, 2.5]), 3); // R = 5.61 < tooth radius 7.63
  assert.equal(at([0.5, 0.5, 2.5]), 0); // corner outside
});

test('mandelbulb-style loop shader: center inside, corner outside', () => {
  assert.equal(evalAt(BULB, [8.5, 8.5, 8.5], { args: { m_degree: 8 }, color: 2 }), 2);
  assert.equal(evalAt(BULB, [0.5, 0.5, 0.5], { args: { m_degree: 8 }, color: 2 }), 0);
});

test('non-finite shader results become empty voxels', () => {
  const program = compileXs(body('float map( vec3 v ) { return 1.0 / 0.0 * 0.0; }'));
  const model = { sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [] };
  assert.equal(runXsOnVolume(program, model, { args: {}, colorIndex: 1, selections: [1], mode: 'replace', timeLimitMs: 1000 }, 100).filled, 0);
});

test('add mode keeps existing voxels where the shader returns zero', () => {
  const program = compileXs(body('float map( vec3 v ) { return v.x < 1.0 ? 5.0 : 0.0; }'));
  const model = { sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [{ x: 1, y: 0, z: 0, i: 9 }] };
  const add = runXsOnVolume(program, model, { args: {}, colorIndex: 1, selections: [1], mode: 'add', timeLimitMs: 1000 }, 100);
  assert.deepEqual(add.voxels.map(v => [v.x, v.i]), [[0, 5], [1, 9]]);
  const replace = runXsOnVolume(program, model, { args: {}, colorIndex: 1, selections: [1], mode: 'replace', timeLimitMs: 1000 }, 100);
  assert.deepEqual(replace.voxels.map(v => [v.x, v.i]), [[0, 5]]);
});

test('every generated template validates and runs', () => {
  for (const kind of XS_TEMPLATE_KINDS) {
    const text = generateXsTemplate(kind);
    const v = validateXsSource(text);
    assert.deepEqual(v.errors, [], kind);
    assert.deepEqual(v.warnings, [], kind);
    assert.equal(v.evaluable, true, `${kind}: ${v.evaluableReason}`);
    const values = Object.fromEntries(v.header.args.map(a => [a.var, a.value]));
    const result = runXsOnVolume(compileXs(text, v.header.args.map(a => a.var)), { sizeX: 12, sizeY: 12, sizeZ: 12, voxels: [] }, { args: values, colorIndex: 2, selections: [2, 3], mode: 'replace', timeLimitMs: 10000 }, 2_000_000);
    assert.ok(result.filled > 0 && result.filled < 12 ** 3 + 1, kind);
  }
  const sphere = generateXsTemplate('sdf-sphere');
  assert.equal(evalAt(sphere, [8.5, 8.5, 8.5], { color: 4 }), 4);
  assert.equal(evalAt(sphere, [0.5, 0.5, 0.5], { color: 4 }), 0);
});

// ------------------------------------------------------------------ corpus: shaders shipped with MagicaVoxel
const home = process.env.MAGICAVOXEL_HOME ?? (process.env.MAGICAVOXEL_PATH ? path.dirname(process.env.MAGICAVOXEL_PATH) : undefined);
const shaderDir = home ? installShaderDir(path.join(home, 'MagicaVoxel.exe')) : null;
const skip = shaderDir ? false : 'MagicaVoxel install not available';
const shipped = (name: string) => readInstalledShader(shaderDir!, name);

test('shipped shaders: sphere, round, torus, stair, poly, gear, mandelbulb agree with the hand-computed values', { skip }, () => {
  assert.equal(evalAt(shipped('sphere'), [8.5, 8.5, 8.5], { color: 7 }), 7);
  assert.equal(evalAt(shipped('sphere'), [0.5, 0.5, 0.5], { color: 7 }), 0);
  const round = (p: [number, number, number]) => evalAt(shipped('round'), p, { size: [8, 8, 8], args: { m_radius: 2 }, color: 9 });
  assert.deepEqual([[3.5, 3.5, 3.5], [0.5, 3.5, 3.5], [0.5, 1.5, 3.5], [0.5, 0.5, 3.5], [0.5, 0.5, 0.5]].map(p => round(p as [number, number, number])), [9, 9, 9, 0, 0]);
  const torus = (p: [number, number, number]) => evalAt(shipped('torus'), p, { args: { m_radius: 3 }, sels: [11, 12] });
  assert.deepEqual([torus([1.5, 8.5, 8.5]), torus([12.5, 8.5, 8.5]), torus([8.5, 8.5, 8.5])], [11, 12, 0]);
  const stair = (p: [number, number, number]) => evalAt(shipped('stair'), p, { size: [8, 8, 8], args: { m_width: 2, m_rise: 1, m_thick: 1, m_dir: 0 }, sels: [5, 6] });
  assert.deepEqual([stair([0.5, 0.5, 7.5]), stair([0.5, 0.5, 6.5]), stair([2.5, 0.5, 6.5]), stair([2.5, 0.5, 7.5]), stair([4.5, 0.5, 5.5])], [5, 0, 6, 0, 5]);
  const poly = (p: [number, number, number]) => evalAt(shipped('poly'), p, { args: { m_side: 4, m_angle: 0 }, color: 4 });
  assert.deepEqual([poly([8.5, 8.5, 8.5]), poly([0.5, 0.5, 8.5])], [4, 0]);
  const gear = (p: [number, number, number]) => evalAt(shipped('gear'), p, { color: 3 });
  assert.deepEqual([gear([8.5, 8.5, 2.5]), gear([13.5, 8.5, 2.5]), gear([0.5, 0.5, 2.5])], [0, 3, 0]);
  const bulb = (p: [number, number, number]) => evalAt(shipped('mandelbulb'), p, { args: { m_degree: 8 }, color: 2 });
  assert.deepEqual([bulb([8.5, 8.5, 8.5]), bulb([0.5, 0.5, 0.5])], [2, 0]);
});

test('shipped sphere shader output equals fill_sphere on a whole volume', { skip }, () => {
  const size = 24;
  const model = { sizeX: size, sizeY: size, sizeZ: size, voxels: [] as { x: number; y: number; z: number; i: number }[] };
  const result = runXsOnVolume(compileXs(shipped('sphere')), model, { args: {}, colorIndex: 5, selections: [5], mode: 'replace', timeLimitMs: 20000 }, 2_000_000);
  fillSphere(model, size / 2 - 0.5, size / 2 - 0.5, size / 2 - 0.5, size / 2, 5);
  const key = (v: { x: number; y: number; z: number; i: number }) => `${v.x},${v.y},${v.z},${v.i}`;
  assert.deepEqual(result.voxels.map(key).sort(), model.voxels.map(key).sort());
});

test('benchmark: all shipped shaders on a 128^3 volume (set XS_BENCH=1)', { skip: skip || (process.env.XS_BENCH ? false : 'set XS_BENCH=1'), timeout: 600000 }, () => {
  for (const name of ['gear', 'mandelbulb', 'poly', 'round', 'sphere', 'stair', 'torus']) {
    const v = validateXsSource(shipped(name));
    const args = Object.fromEntries(v.header.args.map(a => [a.var, a.value]));
    const t0 = Date.now();
    const r = runXsOnVolume(compileXs(shipped(name), v.header.args.map(a => a.var)), { sizeX: 128, sizeY: 128, sizeZ: 128, voxels: [] }, { args, colorIndex: 1, selections: [1, 2, 3, 4], mode: 'replace', timeLimitMs: 120000 }, 20_000_000);
    console.log(`xs-bench ${name}: ${Date.now() - t0} ms, ${r.filled} voxels`);
  }
});

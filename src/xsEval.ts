/**
 * Sandboxed evaluator for a documented subset of the GLSL-like map() function used by xs shaders.
 *
 * The source is tokenized and parsed into an expression tree, which is compiled into closures.
 * There is no eval, no Function constructor and no access to host objects: programs can only
 * touch numbers, small vectors, their own locals and a fixed set of built-in functions.
 * Work is bounded by a per-voxel step budget, a per-loop iteration cap, a call-depth cap
 * (functions must be defined before use, so recursion is impossible) and a wall-clock limit.
 * See docs/xs-shader-evaluation.md for the supported subset.
 */

type Val = number | boolean | number[];
type Frame = Val[];
type Ev = (f: Frame) => Val;
type Ex = (f: Frame) => number; // statement executor: 0 normal, 1 break, 2 continue, 3 return

export class XsSyntaxError extends Error {}
export class XsRuntimeError extends Error {}

export const XS_LIMITS = {
  maxSourceBytes: 64 * 1024,
  maxTokens: 20000,
  maxDepth: 64,
  maxLoopIterations: 4096,
  maxCallDepth: 16,
  maxStepsPerVoxel: 200000,
  maxLocals: 512,
} as const;

// ---------------------------------------------------------------- lexer
interface Token { t: "num" | "id" | "p" | "eof"; s: string; n?: number; line: number; isInt?: boolean }
const PUNCT = ["++", "--", "+=", "-=", "*=", "/=", "==", "!=", "<=", ">=", "&&", "||"];

function tokenize(src: string): Token[] {
  if (Buffer.byteLength(src) > XS_LIMITS.maxSourceBytes) throw new XsSyntaxError("Shader source is too large");
  const out: Token[] = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new XsSyntaxError(`line ${line}: unterminated block comment`);
      for (const ch of src.slice(i, end)) if (ch === "\n") line++;
      i = end + 2; continue;
    }
    if (c === "#") throw new XsSyntaxError(`line ${line}: preprocessor directives are not supported`);
    const num = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[fF]?/.exec(src.slice(i, i + 64));
    if (num) {
      const text = num[0].replace(/[fF]$/, "");
      out.push({ t: "num", s: num[0], n: Number(text), line, isInt: /^\d+$/.test(text) });
      i += num[0].length; continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256));
    if (id) { out.push({ t: "id", s: id[0], line }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (PUNCT.includes(two)) { out.push({ t: "p", s: two, line }); i += 2; }
    else if (/[-+*\/%<>=!?:;,.(){}[\]]/.test(c)) { out.push({ t: "p", s: c, line }); i++; }
    else throw new XsSyntaxError(`line ${line}: unexpected character '${c}'`);
    if (out.length > XS_LIMITS.maxTokens) throw new XsSyntaxError("Shader has too many tokens");
  }
  out.push({ t: "eof", s: "<end>", line });
  if (out.length > XS_LIMITS.maxTokens) throw new XsSyntaxError("Shader has too many tokens");
  return out;
}

// ---------------------------------------------------------------- AST
type Type = "float" | "int" | "bool" | "vec2" | "vec3" | "vec4" | "void";
const TYPES = new Set<string>(["float", "int", "bool", "vec2", "vec3", "vec4", "void"]);
const RESERVED = new Set(["if", "else", "for", "while", "return", "break", "continue", "const", "in", "out", "inout", "uniform", "true", "false", "do", "switch", "struct", "discard", "attribute", "varying", "mat2", "mat3", "mat4", "sampler2D"]);

type E =
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "id"; name: string; line: number }
  | { k: "bin"; op: string; a: E; b: E }
  | { k: "un"; op: string; a: E }
  | { k: "call"; name: string; args: E[]; line: number }
  | { k: "sw"; a: E; sw: string; line: number }
  | { k: "tern"; c: E; a: E; b: E };
type S =
  | { k: "decl"; type: Type; items: { name: string; init?: E }[]; line: number }
  | { k: "assign"; target: E; op: string; value: E; line: number }
  | { k: "expr"; e: E }
  | { k: "if"; c: E; a: S; b?: S }
  | { k: "for"; init?: S; c?: E; step?: S; body: S }
  | { k: "while"; c: E; body: S }
  | { k: "block"; body: S[] }
  | { k: "return"; e?: E; line: number }
  | { k: "break" } | { k: "continue" };
interface FnDef { name: string; ret: Type; params: { name: string; type: Type }[]; body: S[]; line: number }
interface GlobalConst { name: string; type: Type; init: E; line: number }
interface Ast { fns: FnDef[]; consts: GlobalConst[] }

class Parser {
  private p = 0;
  private depth = 0;
  constructor(private toks: Token[]) {}
  private get cur(): Token { return this.toks[this.p]!; }
  private err(msg: string): never { throw new XsSyntaxError(`line ${this.cur.line}: ${msg}`); }
  private is(s: string): boolean { return this.cur.t !== "num" && this.cur.s === s && this.cur.t !== "eof"; }
  private eat(s: string): boolean { if (this.is(s)) { this.p++; return true; } return false; }
  private expect(s: string): void { if (!this.eat(s)) this.err(`expected '${s}' but found '${this.cur.s}'`); }
  private ident(): string {
    if (this.cur.t !== "id" || RESERVED.has(this.cur.s) || TYPES.has(this.cur.s)) this.err(`expected an identifier but found '${this.cur.s}'`);
    return this.toks[this.p++]!.s;
  }
  private isType(): boolean { return this.cur.t === "id" && TYPES.has(this.cur.s); }
  private enter(): void { if (++this.depth > XS_LIMITS.maxDepth) this.err("nesting is too deep"); }
  private leave(): void { this.depth--; }

  parseProgram(): Ast {
    const ast: Ast = { fns: [], consts: [] };
    while (this.cur.t !== "eof") {
      const line = this.cur.line;
      if (this.is("uniform")) this.err("uniform declarations are not supported (built-in arguments are predefined)");
      const isConst = this.eat("const");
      if (!this.isType()) this.err(`expected a type but found '${this.cur.s}'`);
      const type = this.toks[this.p++]!.s as Type;
      const name = this.ident();
      if (this.is("(")) {
        if (isConst) this.err("a function cannot be const");
        this.p++;
        const params: FnDef["params"] = [];
        if (!this.is(")")) {
          do {
            if (this.is("out") || this.is("inout")) this.err("out and inout parameters are not supported");
            this.eat("in");
            if (!this.isType() || this.cur.s === "void") this.err("expected a parameter type");
            const pt = this.toks[this.p++]!.s as Type;
            params.push({ name: this.ident(), type: pt });
          } while (this.eat(","));
        }
        this.expect(")");
        if (this.eat(";")) this.err("function prototypes are not supported; define functions before use");
        this.expect("{");
        ast.fns.push({ name, ret: type, params, body: this.block(), line });
      } else {
        if (!isConst) this.err("only const globals are supported");
        this.expect("=");
        ast.consts.push({ name, type, init: this.expr(), line });
        this.expect(";");
      }
    }
    return ast;
  }
  private block(): S[] {
    this.enter();
    const body: S[] = [];
    while (!this.is("}")) { if (this.cur.t === "eof") this.err("unexpected end of shader (missing '}')"); body.push(this.stmt()); }
    this.expect("}");
    this.leave();
    return body;
  }
  private stmt(): S {
    this.enter();
    try {
      const line = this.cur.line;
      if (this.eat("{")) return { k: "block", body: this.block() };
      if (this.eat(";")) return { k: "block", body: [] };
      if (this.eat("if")) {
        this.expect("("); const c = this.expr(); this.expect(")");
        const a = this.stmt(); const b = this.eat("else") ? this.stmt() : undefined;
        return b ? { k: "if", c, a, b } : { k: "if", c, a };
      }
      if (this.eat("for")) {
        this.expect("(");
        const init = this.is(";") ? undefined : this.simple();
        this.expect(";");
        const c = this.is(";") ? undefined : this.expr();
        this.expect(";");
        const step = this.is(")") ? undefined : this.simple();
        this.expect(")");
        const body = this.stmt();
        return { k: "for", ...(init ? { init } : {}), ...(c ? { c } : {}), ...(step ? { step } : {}), body };
      }
      if (this.eat("while")) { this.expect("("); const c = this.expr(); this.expect(")"); return { k: "while", c, body: this.stmt() }; }
      if (this.eat("return")) { const e = this.is(";") ? undefined : this.expr(); this.expect(";"); return e ? { k: "return", e, line } : { k: "return", line }; }
      if (this.eat("break")) { this.expect(";"); return { k: "break" }; }
      if (this.eat("continue")) { this.expect(";"); return { k: "continue" }; }
      if (this.is("do") || this.is("switch") || this.is("discard")) this.err(`'${this.cur.s}' is not supported`);
      const s = this.simple();
      this.expect(";");
      return s;
    } finally { this.leave(); }
  }
  /** Declaration, assignment, increment or call expression (no trailing semicolon). */
  private simple(): S {
    const line = this.cur.line;
    const isConst = this.eat("const");
    if (this.isType()) {
      const type = this.toks[this.p++]!.s as Type;
      if (type === "void") this.err("void variables are not allowed");
      const items: { name: string; init?: E }[] = [];
      do {
        const name = this.ident();
        if (this.is("[")) this.err("arrays are not supported");
        items.push(this.eat("=") ? { name, init: this.expr() } : { name });
      } while (this.eat(","));
      void isConst;
      return { k: "decl", type, items, line };
    }
    if (isConst) this.err("expected a type after const");
    // pre-increment
    if (this.is("++") || this.is("--")) {
      const op = this.toks[this.p++]!.s; const target = this.unary();
      return { k: "assign", target, op: op === "++" ? "+=" : "-=", value: { k: "num", v: 1 }, line };
    }
    const e = this.expr();
    if (this.cur.t === "p" && ["=", "+=", "-=", "*=", "/="].includes(this.cur.s)) {
      const op = this.toks[this.p++]!.s;
      return { k: "assign", target: e, op, value: this.expr(), line };
    }
    if (this.cur.t === "p" && (this.cur.s === "++" || this.cur.s === "--")) {
      const op = this.toks[this.p++]!.s;
      return { k: "assign", target: e, op: op === "++" ? "+=" : "-=", value: { k: "num", v: 1 }, line };
    }
    if (e.k !== "call") this.err("expression statement has no effect");
    return { k: "expr", e };
  }
  expr(): E { return this.ternary(); }
  private ternary(): E {
    const c = this.binary(0);
    if (this.eat("?")) { this.enter(); const a = this.expr(); this.expect(":"); const b = this.expr(); this.leave(); return { k: "tern", c, a, b }; }
    return c;
  }
  private static LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
  private binary(level: number): E {
    if (level >= Parser.LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    while (this.cur.t === "p" && Parser.LEVELS[level]!.includes(this.cur.s)) {
      const op = this.toks[this.p++]!.s;
      a = { k: "bin", op, a, b: this.binary(level + 1) };
    }
    return a;
  }
  private unary(): E {
    this.enter();
    try {
      if (this.cur.t === "p" && (this.cur.s === "-" || this.cur.s === "+" || this.cur.s === "!")) {
        const op = this.toks[this.p++]!.s; return { k: "un", op, a: this.unary() };
      }
      return this.postfix();
    } finally { this.leave(); }
  }
  private postfix(): E {
    let e = this.primary();
    while (this.is(".")) {
      const line = this.cur.line; this.p++;
      if (this.cur.t !== "id") this.err("expected a component selector after '.'");
      e = { k: "sw", a: e, sw: this.toks[this.p++]!.s, line };
    }
    return e;
  }
  private primary(): E {
    const t = this.cur;
    if (t.t === "num") { this.p++; return { k: "num", v: t.n! }; }
    if (this.eat("(")) { this.enter(); const e = this.expr(); this.leave(); this.expect(")"); return e; }
    if (t.t === "id") {
      if (t.s === "true" || t.s === "false") { this.p++; return { k: "bool", v: t.s === "true" }; }
      const isCtor = TYPES.has(t.s) && t.s !== "void";
      if (!isCtor && RESERVED.has(t.s)) this.err(`unexpected keyword '${t.s}'`);
      this.p++;
      if (this.is("(")) {
        this.p++;
        const args: E[] = [];
        if (!this.is(")")) do { args.push(this.expr()); } while (this.eat(","));
        this.expect(")");
        return { k: "call", name: t.s, args, line: t.line };
      }
      if (isCtor) this.err(`'${t.s}' must be followed by '('`);
      return { k: "id", name: t.s, line: t.line };
    }
    return this.err(`unexpected '${t.s}'`);
  }
}

// ---------------------------------------------------------------- values
const isVec = (v: Val): v is number[] => Array.isArray(v);
const num = (v: Val, what = "value"): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new XsRuntimeError(`${what} must be a scalar`);
};
const truthy = (v: Val): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  throw new XsRuntimeError("condition must be a scalar");
};
function arith(op: string, a: Val, b: Val): number | number[] {
  const fn = op === "+" ? (x: number, y: number) => x + y
    : op === "-" ? (x: number, y: number) => x - y
    : op === "*" ? (x: number, y: number) => x * y
    : op === "/" ? (x: number, y: number) => x / y
    : (x: number, y: number) => x % y;
  if (typeof a === "number" && typeof b === "number") return fn(a, b);
  if (isVec(a) && isVec(b)) {
    if (a.length !== b.length) throw new XsRuntimeError(`vector size mismatch (${a.length} vs ${b.length})`);
    const r = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) r[i] = fn(a[i]!, b[i]!);
    return r;
  }
  if (isVec(a)) return a.map(x => fn(x, num(b)));
  if (isVec(b)) return b.map(y => fn(num(a), y));
  return fn(num(a), num(b));
}
function compare(op: string, a: Val, b: Val): boolean {
  if (isVec(a) || isVec(b)) {
    if (op !== "==" && op !== "!=") throw new XsRuntimeError("relational operators need scalars");
    if (!isVec(a) || !isVec(b) || a.length !== b.length) throw new XsRuntimeError("vector comparison size mismatch");
    const eq = a.every((x, i) => x === b[i]);
    return op === "==" ? eq : !eq;
  }
  const x = num(a), y = num(b);
  switch (op) {
    case "<": return x < y; case ">": return x > y; case "<=": return x <= y; case ">=": return x >= y;
    case "==": return x === y; default: return x !== y;
  }
}
const clone = (v: Val): Val => (isVec(v) ? v.slice() : v);
const SIZE: Record<string, number> = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 };
function coerce(type: Type, v: Val): Val {
  const n = SIZE[type]!;
  if (n === 1) {
    if (isVec(v)) throw new XsRuntimeError(`cannot assign a vector to ${type}`);
    if (type === "int") return Math.trunc(num(v));
    if (type === "bool") return typeof v === "boolean" ? v : v !== 0;
    return num(v);
  }
  if (!isVec(v) || v.length !== n) throw new XsRuntimeError(`cannot assign this value to ${type}`);
  return v.slice();
}
const SW_SETS = ["xyzw", "rgba", "stpq"];
function swizzleIdx(sw: string, size: number, line: number): number[] {
  if (sw.length < 1 || sw.length > 4) throw new XsSyntaxError(`line ${line}: invalid component selector '${sw}'`);
  const set = SW_SETS.find(s => s.includes(sw[0]!));
  if (!set || [...sw].some(ch => !set.includes(ch))) throw new XsSyntaxError(`line ${line}: invalid component selector '${sw}'`);
  const idx = [...sw].map(ch => set.indexOf(ch));
  if (idx.some(i => i >= size)) throw new XsRuntimeError(`line ${line}: component selector '${sw}' is out of range`);
  return idx;
}

// ---------------------------------------------------------------- builtins
type Fn = ((a: Val[]) => Val) & { sc?: (...n: number[]) => number };
const withScalar = (fn: (a: Val[]) => Val, sc: (...n: number[]) => number): Fn => Object.assign(fn, { sc });
const m1 = (f: (x: number) => number): Fn => withScalar((a: Val[]): Val => { const x = a[0]!; return isVec(x) ? x.map(f) : f(num(x)); }, f as (...n: number[]) => number);
const m2 = (f: (x: number, y: number) => number): Fn => withScalar((a: Val[]): Val => {
  const x = a[0]!, y = a[1]!;
  if (isVec(x) && isVec(y)) { if (x.length !== y.length) throw new XsRuntimeError("vector size mismatch"); return x.map((v, i) => f(v, y[i]!)); }
  if (isVec(x)) return x.map(v => f(v, num(y)));
  if (isVec(y)) return y.map(v => f(num(x), v));
  return f(num(x), num(y));
}, f as (...n: number[]) => number);
const m3 = (f: (x: number, y: number, z: number) => number): Fn => withScalar((a: Val[]): Val => {
  const vecs = a.filter(isVec) as number[][];
  if (!vecs.length) return f(num(a[0]!), num(a[1]!), num(a[2]!));
  const n = vecs[0]!.length;
  if (vecs.some(v => v.length !== n)) throw new XsRuntimeError("vector size mismatch");
  return Array.from({ length: n }, (_, i) => f(...(a.map(v => (isVec(v) ? v[i]! : num(v))) as [number, number, number])));
}, f as (...n: number[]) => number);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const vecOf = (v: Val): number[] => { if (!isVec(v)) throw new XsRuntimeError("expected a vector"); return v; };
const dotp = (a: number[], b: number[]) => { if (a.length !== b.length) throw new XsRuntimeError("vector size mismatch"); return a.reduce((s, x, i) => s + x * b[i]!, 0); };
const len = (v: Val) => (isVec(v) ? Math.sqrt(dotp(v, v)) : Math.abs(num(v)));
const mod = (x: number, y: number) => x - y * Math.floor(x / y);

const PURE: Record<string, { arity: number[]; fn: Fn }> = {
  radians: { arity: [1], fn: m1(x => x * Math.PI / 180) }, degrees: { arity: [1], fn: m1(x => x * 180 / Math.PI) },
  sin: { arity: [1], fn: m1(Math.sin) }, cos: { arity: [1], fn: m1(Math.cos) }, tan: { arity: [1], fn: m1(Math.tan) },
  asin: { arity: [1], fn: m1(Math.asin) }, acos: { arity: [1], fn: m1(Math.acos) },
  atan: { arity: [1, 2], fn: Object.assign((a: Val[]) => (a.length === 2 ? m2(Math.atan2)(a) : m1(Math.atan)(a)), { sc: ((y: number, x?: number) => (x === undefined ? Math.atan(y) : Math.atan2(y, x))) as (...n: number[]) => number }) },
  exp: { arity: [1], fn: m1(Math.exp) }, log: { arity: [1], fn: m1(Math.log) }, exp2: { arity: [1], fn: m1(x => 2 ** x) }, log2: { arity: [1], fn: m1(Math.log2) },
  sqrt: { arity: [1], fn: m1(Math.sqrt) }, inversesqrt: { arity: [1], fn: m1(x => 1 / Math.sqrt(x)) },
  pow: { arity: [2], fn: m2(Math.pow) }, abs: { arity: [1], fn: m1(Math.abs) }, sign: { arity: [1], fn: m1(Math.sign) },
  floor: { arity: [1], fn: m1(Math.floor) }, ceil: { arity: [1], fn: m1(Math.ceil) }, trunc: { arity: [1], fn: m1(Math.trunc) },
  round: { arity: [1], fn: m1(x => Math.floor(x + 0.5)) }, fract: { arity: [1], fn: m1(x => x - Math.floor(x)) },
  mod: { arity: [2], fn: m2(mod) }, min: { arity: [2], fn: m2(Math.min) }, max: { arity: [2], fn: m2(Math.max) },
  clamp: { arity: [3], fn: m3((x, lo, hi) => Math.min(Math.max(x, lo), hi)) },
  mix: { arity: [3], fn: m3((x, y, t) => x * (1 - t) + y * t) },
  step: { arity: [2], fn: m2((edge, x) => (x >= edge ? 1 : 0)) },
  smoothstep: { arity: [3], fn: m3((e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }) },
  length: { arity: [1], fn: a => len(a[0]!) },
  distance: { arity: [2], fn: a => len(arith("-", a[0]!, a[1]!)) },
  dot: { arity: [2], fn: a => dotp(vecOf(a[0]!), vecOf(a[1]!)) },
  cross: { arity: [2], fn: a => {
    const x = vecOf(a[0]!), y = vecOf(a[1]!);
    if (x.length !== 3 || y.length !== 3) throw new XsRuntimeError("cross needs vec3 arguments");
    return [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!];
  } },
  normalize: { arity: [1], fn: a => { const v = vecOf(a[0]!); const l = len(v); return v.map(x => x / l); } },
};

// ---------------------------------------------------------------- compiler
export interface XsRuntimeInput {
  volumeSize: [number, number, number];
  colorIndex: number;
  selections: number[];
  args: Record<string, number>;
  /** Color index at an integer voxel position (0 outside / empty). */
  voxelAt?: (x: number, y: number, z: number) => number;
  /** Packed 0xAABBGGRR style RGBA for palette index 0..255. */
  paletteAt?: (index: number) => number;
}
class Budget { steps = 0; limit = XS_LIMITS.maxStepsPerVoxel; ret: Val = 0; depth = 0; }

export interface XsProgram {
  /** Names of global identifiers available to the program (built-in args plus declared arg variables). */
  argNames: string[];
  /** Create an evaluator for one run: returns the shader color value at a voxel center. */
  instantiate(input: XsRuntimeInput): (x: number, y: number, z: number) => number;
}

const BUILTIN_GLOBALS = new Set(["i_volume_size", "i_color_index", "i_num_color_sels"]);
const BUILTIN_FNS = new Set(["voxel", "color_sel", "palette"]);

/** Compile shader source. Throws XsSyntaxError for anything outside the supported subset. */
export function compileXs(source: string, argNames: string[] = []): XsProgram {
  const ast = new Parser(tokenize(source)).parseProgram();
  const map = ast.fns.find(f => f.name === "map");
  if (!map) throw new XsSyntaxError("no map() function found");
  if (map.ret !== "float" || map.params.length !== 1 || map.params[0]!.type !== "vec3") throw new XsSyntaxError("map must have the signature float map(vec3 v)");
  const globalNames = [...BUILTIN_GLOBALS, ...argNames];
  const rtHolder: { b: Budget; input: XsRuntimeInput; G: Val[] } = { b: new Budget(), input: undefined as unknown as XsRuntimeInput, G: [] };
  const fnTable = new Map<string, { def: FnDef; run: (args: Val[]) => Val }>();

  type Scope = Map<string, { slot: number; type: Type }>;
  const globalSlot = new Map<string, { slot: number; type: Type }>();
  globalNames.forEach((n, i) => globalSlot.set(n, { slot: i, type: n === "i_volume_size" ? "vec3" : n === "i_num_color_sels" ? "int" : "float" }));
  const compileScopeless = (): void => {};
  void compileScopeless;

  class FnCompiler {
    scopes: Scope[] = [new Map()];
    nslots = 0;
    constructor(private fn: FnDef | null, private line = 0) {}
    declare(name: string, type: Type, line: number): number {
      const top = this.scopes[this.scopes.length - 1]!;
      if (top.has(name)) throw new XsSyntaxError(`line ${line}: '${name}' is already declared in this scope`);
      if (RESERVED.has(name)) throw new XsSyntaxError(`line ${line}: '${name}' is a reserved word`);
      if (this.nslots >= XS_LIMITS.maxLocals) throw new XsSyntaxError("too many local variables");
      const slot = this.nslots++;
      top.set(name, { slot, type });
      return slot;
    }
    lookup(name: string): { slot: number; type: Type; global: boolean } | undefined {
      for (let i = this.scopes.length - 1; i >= 0; i--) { const v = this.scopes[i]!.get(name); if (v) return { ...v, global: false }; }
      const g = globalSlot.get(name);
      return g ? { ...g, global: true } : undefined;
    }
    expr(e: E): Ev {
      const b = rtHolder.b;
      switch (e.k) {
        case "num": { const v = e.v; return () => v; }
        case "bool": { const v = e.v; return () => v; }
        case "id": {
          const v = this.lookup(e.name);
          if (!v) throw new XsSyntaxError(`line ${e.line}: undefined identifier '${e.name}'`);
          const s = v.slot;
          return v.global ? () => rtHolder.G[s]! : f => f[s]!;
        }
        case "un": {
          const a = this.expr(e.a);
          if (e.op === "-") return f => { const x = a(f); return isVec(x) ? x.map(y => -y) : -num(x); };
          if (e.op === "+") return a;
          return f => !truthy(a(f));
        }
        case "bin": {
          const a = this.expr(e.a), c = this.expr(e.b), op = e.op;
          if (op === "&&") return f => truthy(a(f)) && truthy(c(f));
          if (op === "||") return f => truthy(a(f)) || truthy(c(f));
          if (op === "+") return f => { const x = a(f), y = c(f); return typeof x === "number" && typeof y === "number" ? x + y : arith("+", x, y); };
          if (op === "-") return f => { const x = a(f), y = c(f); return typeof x === "number" && typeof y === "number" ? x - y : arith("-", x, y); };
          if (op === "*") return f => { const x = a(f), y = c(f); return typeof x === "number" && typeof y === "number" ? x * y : arith("*", x, y); };
          if (op === "/" || op === "%") return f => arith(op, a(f), c(f));
          return f => compare(op, a(f), c(f));
        }
        case "tern": {
          const c = this.expr(e.c), a = this.expr(e.a), d = this.expr(e.b);
          return f => (truthy(c(f)) ? a(f) : d(f));
        }
        case "sw": {
          const a = this.expr(e.a), sw = e.sw, line = e.line;
          if (!/^[xyzwrgbastpq]{1,4}$/.test(sw)) throw new XsSyntaxError(`line ${line}: invalid component selector '${sw}'`);
          let cached: number[] | null = null;
          return f => {
            const v = a(f);
            if (!isVec(v)) throw new XsRuntimeError(`line ${line}: component selector on a scalar`);
            const idx = cached && cached.length === sw.length ? cached : (cached = swizzleIdx(sw, 4, line));
            if (idx.some(i => i >= v.length)) throw new XsRuntimeError(`line ${line}: component selector '${sw}' is out of range`);
            return idx.length === 1 ? v[idx[0]!]! : idx.map(i => v[i]!);
          };
        }
        case "call": return this.call(e, b);
      }
    }
    call(e: Extract<E, { k: "call" }>, b: Budget): Ev {
      const args = e.args.map(a => this.expr(a));
      const name = e.name, line = e.line;
      const tick = () => { if (++b.steps > b.limit) throw new XsRuntimeError("step budget exceeded"); };
      const wrap = (fn: (a: Val[]) => Val): Ev => f => { tick(); try { return fn(args.map(a => a(f))); } catch (err) { if (err instanceof XsRuntimeError && !/^line /.test(err.message)) throw new XsRuntimeError(`line ${line}: ${name}(): ${err.message}`); throw err; } };
      if (TYPES.has(name)) {
        if (name === "void") throw new XsSyntaxError(`line ${line}: invalid constructor`);
        const n = SIZE[name]!;
        return wrap(a => {
          if (n === 1) {
            if (a.length !== 1) throw new XsRuntimeError("expects one argument");
            const x = a[0]!; if (isVec(x)) throw new XsRuntimeError("cannot convert a vector to a scalar");
            return name === "int" ? Math.trunc(num(x)) : name === "bool" ? truthy(x) : num(x);
          }
          const flat: number[] = [];
          for (const x of a) { if (isVec(x)) flat.push(...x); else flat.push(num(x)); }
          if (flat.length === 1 && a.length === 1) return new Array<number>(n).fill(flat[0]!);
          if (flat.length < n) throw new XsRuntimeError(`not enough components for ${name}`);
          if (flat.length > n && a.length === 1 && !isVec(a[0]!)) return flat.slice(0, n);
          if (flat.length !== n && !(a.length === 1 && isVec(a[0]!))) throw new XsRuntimeError(`wrong component count for ${name}`);
          return flat.slice(0, n);
        });
      }
      const user = fnTable.get(name);
      if (user) {
        if (user.def.params.length !== args.length) throw new XsSyntaxError(`line ${line}: ${name}() expects ${user.def.params.length} arguments`);
        return f => { tick(); return user.run(args.map(a => a(f))); };
      }
      if (BUILTIN_FNS.has(name)) {
        if (args.length !== 1) throw new XsSyntaxError(`line ${line}: ${name}() expects 1 argument`);
        if (name === "voxel") return wrap(a => { const v = vecOf(a[0]!); if (v.length !== 3) throw new XsRuntimeError("expects a vec3"); const fn = rtHolder.input.voxelAt; return fn ? fn(Math.floor(v[0]!), Math.floor(v[1]!), Math.floor(v[2]!)) : 0; });
        if (name === "color_sel") return wrap(a => { const s = rtHolder.input.selections; const k = Math.floor(num(a[0]!)); return s.length ? s[Math.min(Math.max(k, 0), s.length - 1)]! : rtHolder.input.colorIndex; });
        return wrap(a => {
          const idx = Math.min(Math.max(Math.floor(num(a[0]!)), 0), 255);
          const rgba = rtHolder.input.paletteAt ? rtHolder.input.paletteAt(idx) >>> 0 : 0;
          return [(rgba & 255) / 255, ((rgba >>> 8) & 255) / 255, ((rgba >>> 16) & 255) / 255, ((rgba >>> 24) & 255) / 255];
        });
      }
      const pure = PURE[name];
      if (!pure) throw new XsSyntaxError(`line ${line}: unsupported function '${name}'`);
      if (!pure.arity.includes(args.length)) throw new XsSyntaxError(`line ${line}: ${name}() does not accept ${args.length} arguments`);
      const pf = pure.fn, sc = pf.sc, a0 = args[0]!, a1 = args[1], a2 = args[2];
      const slow = wrap(pf);
      if (sc && args.length === 1) return f => { const x = a0(f); if (typeof x === "number") { tick(); return sc(x); } return slow(f); };
      if (sc && args.length === 2) return f => { const x = a0(f), y = a1!(f); if (typeof x === "number" && typeof y === "number") { tick(); return sc(x, y); } return slow(f); };
      if (sc && args.length === 3) return f => { const x = a0(f), y = a1!(f), z = a2!(f); if (typeof x === "number" && typeof y === "number" && typeof z === "number") { tick(); return sc(x, y, z); } return slow(f); };
      return slow;
    }
    stmt(s: S): Ex {
      const b = rtHolder.b;
      const tick = () => { if (++b.steps > b.limit) throw new XsRuntimeError("step budget exceeded"); };
      switch (s.k) {
        case "block": {
          this.scopes.push(new Map());
          const body = s.body.map(x => this.stmt(x));
          this.scopes.pop();
          return f => { for (const x of body) { const r = x(f); if (r) return r; } return 0; };
        }
        case "decl": {
          const items = s.items.map(it => {
            const init = it.init ? this.expr(it.init) : null; // compile before declaring
            const slot = this.declare(it.name, s.type, s.line);
            return { slot, init };
          });
          const type = s.type;
          return f => {
            tick();
            for (const it of items) f[it.slot] = it.init ? coerce(type, it.init(f)) : (SIZE[type]! === 1 ? (type === "bool" ? false : 0) : new Array<number>(SIZE[type]!).fill(0));
            return 0;
          };
        }
        case "assign": return this.assign(s, tick);
        case "expr": { const e = this.expr(s.e); return f => { tick(); e(f); return 0; }; }
        case "if": {
          const c = this.expr(s.c);
          this.scopes.push(new Map()); const a = this.stmt(s.a); this.scopes.pop();
          let d: Ex | null = null;
          if (s.b) { this.scopes.push(new Map()); d = this.stmt(s.b); this.scopes.pop(); }
          return f => { tick(); return truthy(c(f)) ? a(f) : d ? d(f) : 0; };
        }
        case "while": {
          const c = this.expr(s.c);
          this.scopes.push(new Map()); const body = this.stmt(s.body); this.scopes.pop();
          return f => {
            let n = 0;
            while (truthy(c(f))) {
              tick(); if (++n > XS_LIMITS.maxLoopIterations) throw new XsRuntimeError("loop iteration limit exceeded");
              const r = body(f); if (r === 1) break; if (r === 3) return 3;
            }
            return 0;
          };
        }
        case "for": {
          this.scopes.push(new Map());
          const init = s.init ? this.stmt(s.init) : null;
          const c = s.c ? this.expr(s.c) : null;
          const step = s.step ? this.stmt(s.step) : null;
          this.scopes.push(new Map()); const body = this.stmt(s.body); this.scopes.pop();
          this.scopes.pop();
          return f => {
            if (init) init(f);
            let n = 0;
            while (!c || truthy(c(f))) {
              tick(); if (++n > XS_LIMITS.maxLoopIterations) throw new XsRuntimeError("loop iteration limit exceeded");
              const r = body(f); if (r === 1) break; if (r === 3) return 3;
              if (step) step(f);
            }
            return 0;
          };
        }
        case "return": {
          const fn = this.fn!;
          if (fn.ret === "void") { if (s.e) throw new XsSyntaxError(`line ${s.line}: void function cannot return a value`); return () => { b.ret = 0; return 3; }; }
          if (!s.e) throw new XsSyntaxError(`line ${s.line}: missing return value`);
          const e = this.expr(s.e); const rt = fn.ret;
          return f => { tick(); b.ret = coerce(rt, e(f)); return 3; };
        }
        case "break": return () => 1;
        case "continue": return () => 2;
      }
    }
    assign(s: Extract<S, { k: "assign" }>, tick: () => void): Ex {
      const value = this.expr(s.value), op = s.op;
      const combine = (cur: Val, v: Val): Val => (op === "=" ? v : arith(op[0]!, cur, v));
      const t = s.target;
      const root = t.k === "sw" ? t.a : t;
      if (root.k !== "id") throw new XsSyntaxError(`line ${s.line}: invalid assignment target`);
      const v = this.lookup(root.name);
      if (!v) throw new XsSyntaxError(`line ${s.line}: undefined identifier '${root.name}'`);
      if (v.global) throw new XsSyntaxError(`line ${s.line}: cannot assign to built-in or argument '${root.name}'`);
      const slot = v.slot, type = v.type;
      if (t.k === "id") return f => { tick(); f[slot] = coerce(type, combine(f[slot]!, value(f))); return 0; };
      if (t.k !== "sw") throw new XsSyntaxError(`line ${s.line}: invalid assignment target`);
      const line = s.line, sw = t.sw;
      if (!/^[xyzwrgbastpq]{1,4}$/.test(sw)) throw new XsSyntaxError(`line ${line}: invalid component selector '${sw}'`);
      return f => {
        tick();
        const cur = f[slot]!;
        if (!isVec(cur)) throw new XsRuntimeError(`line ${line}: component selector on a scalar`);
        const idx = swizzleIdx(sw, cur.length, line);
        if (new Set(idx).size !== idx.length) throw new XsRuntimeError(`line ${line}: repeated component in assignment`);
        const old: Val = idx.length === 1 ? cur[idx[0]!]! : idx.map(i => cur[i]!);
        const nv = combine(old, value(f));
        const parts = idx.length === 1 ? [num(nv)] : isVec(nv) && nv.length === idx.length ? nv : (() => { throw new XsRuntimeError(`line ${line}: component count mismatch`); })();
        const out = cur.slice();
        idx.forEach((i, k) => { out[i] = parts[k]!; });
        f[slot] = out;
        return 0;
      };
    }
    compileFunction(def: FnDef): { nslots: number; body: Ex[] } {
      for (const p of def.params) this.declare(p.name, p.type, def.line);
      const body = def.body.map(s => this.stmt(s));
      return { nslots: this.nslots, body };
    }
  }

  // global constants: evaluated once per instantiation, in order
  const constInits: { slot: number; type: Type; ev: Ev }[] = [];
  for (const c of ast.consts) {
    if (globalSlot.has(c.name)) throw new XsSyntaxError(`line ${c.line}: '${c.name}' is already declared`);
    const fc = new FnCompiler(null);
    const ev = fc.expr(c.init);
    const slot = globalNames.length + constInits.length;
    constInits.push({ slot, type: c.type, ev });
    globalSlot.set(c.name, { slot, type: c.type });
  }

  const b = rtHolder.b;
  for (const def of ast.fns) {
    if (fnTable.has(def.name) || PURE[def.name] || BUILTIN_FNS.has(def.name) || TYPES.has(def.name)) throw new XsSyntaxError(`line ${def.line}: function '${def.name}' is already defined`);
    const fc = new FnCompiler(def);
    // register after compiling the body: a function cannot call itself or later functions
    const { nslots, body } = fc.compileFunction(def);
    const params = def.params;
    fnTable.set(def.name, {
      def,
      run: (args: Val[]) => {
        if (++b.depth > XS_LIMITS.maxCallDepth) throw new XsRuntimeError("call depth exceeded");
        try {
          const frame: Frame = new Array<Val>(nslots).fill(0);
          params.forEach((p, i) => { frame[i] = coerce(p.type, args[i]!); });
          b.ret = def.ret === "void" ? 0 : (SIZE[def.ret] === 1 ? 0 : new Array<number>(SIZE[def.ret]!).fill(0));
          for (const s of body) { if (s(frame) === 3) break; }
          return b.ret;
        } finally { b.depth--; }
      },
    });
  }
  const mapFn = fnTable.get("map")!;

  return {
    argNames: globalNames.slice(),
    instantiate(input: XsRuntimeInput) {
      const G: Val[] = [
        input.volumeSize.slice(), input.colorIndex, input.selections.length || 1,
        ...argNames.map(n => {
          const v = input.args[n];
          if (v === undefined || !Number.isFinite(v)) throw new XsRuntimeError(`argument '${n}' has no numeric value`);
          return v;
        }),
      ];
      rtHolder.input = input; rtHolder.G = G;
      for (const c of constInits) { b.steps = 0; G[c.slot] = coerce(c.type, c.ev([])); }
      const pos: number[] = [0, 0, 0];
      return (x: number, y: number, z: number): number => {
        b.steps = 0; b.depth = 0;
        pos[0] = x; pos[1] = y; pos[2] = z;
        const r = mapFn.run([pos.slice()]);
        return typeof r === "number" ? r : NaN;
      };
    },
  };
}

// ---------------------------------------------------------------- model runner
export interface XsRunOptions {
  args: Record<string, number>;
  colorIndex: number;
  selections: number[];
  /** replace: every voxel takes the shader value (0 clears); add: only non-zero values overwrite. */
  mode: "replace" | "add";
  timeLimitMs: number;
}
export interface XsRunResult { voxels: { x: number; y: number; z: number; i: number }[]; changed: number; filled: number; elapsedMs: number }

/** Evaluate a compiled program over the whole volume of a model. Does not mutate the model. */
export function runXsOnVolume(program: XsProgram, model: { sizeX: number; sizeY: number; sizeZ: number; voxels: { x: number; y: number; z: number; i: number }[]; palette?: Uint32Array | number[] }, options: XsRunOptions, maxVoxels: number): XsRunResult {
  const { sizeX, sizeY, sizeZ } = model;
  const total = sizeX * sizeY * sizeZ;
  const before = new Uint8Array(total);
  const at = (x: number, y: number, z: number) => x + sizeX * (y + sizeY * z);
  for (const v of model.voxels) before[at(v.x, v.y, v.z)] = v.i;
  const map = program.instantiate({
    volumeSize: [sizeX, sizeY, sizeZ], colorIndex: options.colorIndex, selections: options.selections, args: options.args,
    voxelAt: (x, y, z) => (x >= 0 && y >= 0 && z >= 0 && x < sizeX && y < sizeY && z < sizeZ ? before[at(x, y, z)]! : 0),
    ...(model.palette ? { paletteAt: (i: number) => Number(model.palette![i] ?? 0) } : {}),
  });
  const start = Date.now(), deadline = start + options.timeLimitMs;
  const voxels: XsRunResult["voxels"] = [];
  let changed = 0, counter = 0;
  for (let z = 0; z < sizeZ; z++) for (let y = 0; y < sizeY; y++) for (let x = 0; x < sizeX; x++) {
    if ((++counter & 1023) === 0 && Date.now() > deadline) throw new XsRuntimeError(`time limit of ${options.timeLimitMs} ms exceeded`);
    const raw = map(x + 0.5, y + 0.5, z + 0.5);
    const value = Number.isFinite(raw) ? Math.min(255, Math.max(0, Math.floor(raw + 0.5))) : 0;
    const old = before[at(x, y, z)]!;
    const result = options.mode === "add" && value === 0 ? old : value;
    if (result !== old) changed++;
    if (result > 0) {
      voxels.push({ x, y, z, i: result });
      if (voxels.length > maxVoxels) throw new XsRuntimeError(`result exceeds the voxel limit (${maxVoxels})`);
    }
  }
  return { voxels, changed, filled: voxels.length, elapsedMs: Date.now() - start };
}

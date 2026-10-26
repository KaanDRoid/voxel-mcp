import fs from "node:fs";
import path from "node:path";
import { compileXs, XsRuntimeError, XsSyntaxError } from "./xsEval.js";

export interface XsArg { var: string; name: string; value: number; range: [number, number]; step: number; precision: number }
export interface XsHeader { present: boolean; author?: string; src?: string; fields: Record<string, string>; args: XsArg[] }
export interface XsValidation { valid: boolean; errors: string[]; warnings: string[]; header: XsHeader; hasMap: boolean; evaluable: boolean; evaluableReason?: string }

export const XS_MAX_BYTES = 256 * 1024;
export const XS_MAX_ARGS = 32;
export const BUILTIN_ARGS = ["i_volume_size", "i_color_index", "i_num_color_sels"] as const;
export const BUILTIN_FUNCTIONS = ["voxel", "color_sel", "palette"] as const;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse "key = 'value' key2 = 'value2'" lists as used inside "arg : { ... }". */
export function parseKeyValues(body: string): { pairs: Record<string, string>; error?: string } {
  const pairs: Record<string, string> = {};
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'/y;
  let pos = 0;
  body = body.trim();
  while (pos < body.length) {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) return { pairs, error: `cannot parse near "${body.slice(pos, pos + 20).trim()}"` };
    if (Object.hasOwn(pairs, m[1]!)) return { pairs, error: `duplicate field '${m[1]}'` };
    pairs[m[1]!] = m[2]!;
    pos = re.lastIndex;
    while (pos < body.length && /\s/.test(body[pos]!)) pos++;
  }
  return { pairs };
}

/** Parse the "// xs_begin ... // xs_end" header. Problems are appended to errors/warnings. */
export function parseXsHeader(source: string, errors: string[] = [], warnings: string[] = []): XsHeader {
  const lines = source.split(/\r?\n/);
  const header: XsHeader = { present: false, fields: {}, args: [] };
  let begin = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (/^\/\/\s*xs_begin\s*$/.test(t)) begin = i;
    break;
  }
  if (begin < 0) { errors.push("missing '// xs_begin' on the first non-blank line"); return header; }
  header.present = true;
  for (let i = begin + 1; i < lines.length; i++) {
    if (/^\s*\/\/\s*xs_end\s*$/.test(lines[i]!)) { end = i; break; }
  }
  if (end < 0) { errors.push("missing '// xs_end'"); return header; }
  const seen = new Set<string>();
  for (let i = begin + 1; i < end; i++) {
    const raw = lines[i]!.trim();
    const where = `header line ${i + 1}`;
    if (!raw) continue;
    const m = /^\/\/\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) { errors.push(`${where}: expected '// key : value'`); continue; }
    const key = m[1]!, rest = m[2]!.trim();
    if (key === "arg") {
      const block = /^\{(.*)\}$/.exec(rest);
      if (!block) { errors.push(`${where}: arg must be written as { var = '..' name = '..' ... }`); continue; }
      const { pairs, error } = parseKeyValues(block[1]!);
      if (error) { errors.push(`${where}: ${error}`); continue; }
      const arg = buildArg(pairs, where, errors, warnings);
      if (!arg) continue;
      if (seen.has(arg.var)) { errors.push(`${where}: duplicate arg variable '${arg.var}'`); continue; }
      seen.add(arg.var);
      header.args.push(arg);
    } else {
      const v = /^'([^']*)'$/.exec(rest);
      if (!v) { errors.push(`${where}: value of '${key}' must be quoted with single quotes`); continue; }
      header.fields[key] = v[1]!;
      if (key === "author") header.author = v[1]!;
      if (key === "src") header.src = v[1]!;
    }
  }
  if (header.args.length > XS_MAX_ARGS) errors.push(`too many args (${header.args.length}, maximum ${XS_MAX_ARGS})`);
  return header;
}

function buildArg(p: Record<string, string>, where: string, errors: string[], warnings: string[]): XsArg | null {
  const before = errors.length;
  for (const k of ["var", "name", "value", "range", "step", "precision"]) if (p[k] === undefined) errors.push(`${where}: arg is missing '${k}'`);
  for (const k of Object.keys(p)) if (!["var", "name", "value", "range", "step", "precision"].includes(k)) warnings.push(`${where}: unknown arg field '${k}'`);
  if (errors.length > before) return null;
  const v = p.var!;
  if (!IDENT.test(v)) errors.push(`${where}: invalid variable name '${v}'`);
  else if (!v.startsWith("m_")) warnings.push(`${where}: variable '${v}' does not start with 'm_'`);
  const numeric = (s: string): number => (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s.trim()) ? Number(s) : NaN);
  const value = numeric(p.value!);
  if (Number.isNaN(value)) errors.push(`${where}: value '${p.value}' is not a number`);
  const parts = p.range!.trim().split(/\s+/);
  const lo = numeric(parts[0] ?? ""), hi = numeric(parts[1] ?? "");
  if (parts.length !== 2 || Number.isNaN(lo) || Number.isNaN(hi)) errors.push(`${where}: range must be two numbers`);
  else if (lo > hi) errors.push(`${where}: range minimum exceeds maximum`);
  const step = numeric(p.step!);
  if (Number.isNaN(step) || step <= 0) errors.push(`${where}: step must be a positive number`);
  const precision = numeric(p.precision!);
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) errors.push(`${where}: precision must be an integer 0..8`);
  if (errors.length > before) return null;
  if (value < lo || value > hi) warnings.push(`${where}: value ${value} is outside the range`);
  return { var: v, name: p.name!, value, range: [lo, hi], step, precision };
}

/** Remove // and block comments, keeping line structure. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

export function validateXsSource(source: string): XsValidation {
  const errors: string[] = [], warnings: string[] = [];
  if (Buffer.byteLength(source) > XS_MAX_BYTES) errors.push(`shader exceeds ${XS_MAX_BYTES} bytes`);
  if (/\0/.test(source)) errors.push("shader contains NUL bytes");
  const header = parseXsHeader(source, errors, warnings);
  const code = stripComments(source);
  const hasMap = /\bfloat\s+map\s*\(\s*vec3\s+[A-Za-z_][A-Za-z0-9_]*\s*\)\s*\{/.test(code);
  if (!hasMap) errors.push("missing 'float map(vec3 v) { ... }'");
  const count = (ch: string) => code.split(ch).length - 1;
  if (count("{") !== count("}")) errors.push("unbalanced braces");
  if (count("(") !== count(")")) errors.push("unbalanced parentheses");
  const declared = new Set(header.args.map(a => a.var));
  const used = new Set(code.match(/\bm_[A-Za-z0-9_]*/g) ?? []);
  for (const u of used) if (!declared.has(u)) warnings.push(`'${u}' is used but not declared in the header`);
  for (const d of declared) if (!used.has(d)) warnings.push(`arg '${d}' is declared but never used`);
  let evaluable = false, evaluableReason: string | undefined;
  if (errors.length === 0) {
    try { compileXs(source, header.args.map(a => a.var)); evaluable = true; }
    catch (e) { evaluableReason = e instanceof XsSyntaxError || e instanceof XsRuntimeError ? e.message : "unsupported"; }
  } else evaluableReason = "shader is not valid";
  return { valid: errors.length === 0, errors, warnings, header, hasMap, evaluable, ...(evaluableReason ? { evaluableReason } : {}) };
}

// ------------------------------------------------------------ install folder
/** Folder holding the user's MagicaVoxel shaders, or null when the install location is unknown. */
export function installShaderDir(executablePath: string | null): string | null {
  const candidates: string[] = [];
  if (process.env.MAGICAVOXEL_HOME) candidates.push(path.resolve(process.env.MAGICAVOXEL_HOME));
  if (executablePath) candidates.push(path.dirname(executablePath));
  for (const base of candidates) {
    const dir = path.join(base, "shader");
    try { if (fs.statSync(dir).isDirectory()) return fs.realpathSync(dir); } catch { /* try next */ }
  }
  return null;
}

export const SHADER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function readInstalledShader(dir: string, name: string): string {
  if (!SHADER_NAME.test(name)) throw new Error("Shader name may only contain letters, digits, '_' and '-'");
  const file = path.join(dir, `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error(`Installed shader '${name}' not found`);
  const real = fs.realpathSync(file);
  if (path.dirname(real) !== dir) throw new Error("Shader is outside the shader folder");
  return readLimited(real);
}

export function readLimited(file: string): string {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("Shader path must be a regular file");
  if (st.size > XS_MAX_BYTES) throw new Error(`Shader file exceeds ${XS_MAX_BYTES} bytes`);
  return fs.readFileSync(file, "utf8");
}

export interface XsListEntry { name: string; location: "workspace" | "install"; file: string; author?: string; args: string[]; valid: boolean; error?: string }

export function listShaders(dir: string, location: "workspace" | "install", limit = 500): XsListEntry[] {
  const out: XsListEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) break;
    if (!entry.isFile() || !/\.txt$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const text = readLimited(file);
      if (!/^\s*\/\/\s*xs_begin/.test(text)) continue; // not a shader
      const v = validateXsSource(text);
      out.push({ name: entry.name.replace(/\.txt$/i, ""), location, file: entry.name, ...(v.header.author ? { author: v.header.author } : {}), args: v.header.args.map(a => a.var), valid: v.valid, ...(v.valid ? {} : { error: v.errors[0]! }) });
    } catch (e) {
      out.push({ name: entry.name.replace(/\.txt$/i, ""), location, file: entry.name, args: [], valid: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

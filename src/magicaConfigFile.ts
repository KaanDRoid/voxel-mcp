import fs from "node:fs";

export type ConfigValue = string | number | number[];
export type ConfigSection = Record<string, ConfigValue>;
export interface ParsedConfig { config: Record<string, ConfigSection>; warnings: string[] }

const MAX_BYTES = 1024 * 1024;

/** Values observed in the stock 0.99.7.2 config.txt, used when a key is absent. Directory entries use the "$" convention. */
const DEFAULTS: Record<string, ConfigSection> = {
  workspace: { dir_model: "$/vox", dir_pattern: "$/vox", dir_palette: "$/palette", dir_export: "$/export", dir_snapshot: "$/export", dir_xs_shader: "$/shader", dir_ibl: "$/ibl", dir_plugin: "$/plugin", rename_prefix: "-", rename_suffix: "" },
  view: { ui_scale: 1.125, ambient_color: [0.19, 0.18, 0.26] },
  render: { dense_buffer: 256, sparse_buffer: 256 },
  io_iso: { size: 2, height: 4, view: 4, outline: 1, top: [1.17, 1.15, 1.25], left: [0.37, 0.35, 0.55], right: [0.87, 0.85, 0.95], bevel: [0.13, 0.13, 0.13] },
  io_2d: { size: 16, shadow: 1, outline: 0 },
  io_obj: { scale: 0.1, axis: "XZ-Y", cw: 0, merge: 1 },
  io_ply: { scale: 0.1, axis: "XYZ", cw: 0 },
  io_mc: { scale: 0.1, axis: "XYZ", cw: 0 },
  io_cube: { scale: 0.1, axis: "XYZ", cw: 0, margin: 0.1 },
  io_point: { scale: 1, axis: "XYZ", sample_offset: [0, 0, 0] }
};

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
function typed(raw: string): ConfigValue {
  const text = raw.trim();
  if (NUMBER.test(text)) return Number(text);
  const parts = text.split(/\s+/);
  if (parts.length > 1 && parts.every(p => NUMBER.test(p))) return parts.map(Number);
  return text;
}

/** Replace a leading "$" (the application's own folder) with the installation root. Other paths are untouched. */
function resolveDir(value: string, root: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (value === "$") return base;
  if (value.startsWith("$/") || value.startsWith("$\\")) return `${base}/${value.slice(2).replace(/\\/g, "/")}`;
  return value;
}

function finish(sections: Record<string, ConfigSection>, root: string): Record<string, ConfigSection> {
  const out: Record<string, ConfigSection> = {};
  for (const name of new Set([...Object.keys(DEFAULTS), ...Object.keys(sections)])) {
    const merged: ConfigSection = { ...(DEFAULTS[name] ?? {}), ...(sections[name] ?? {}) };
    if (name === "workspace") for (const [k, v] of Object.entries(merged)) if (k.startsWith("dir_") && typeof v === "string") merged[k] = resolveDir(v, root);
    out[name] = merged;
  }
  return out;
}

/** Parse config.txt text. Never throws: problems become warnings and missing keys fall back to defaults. */
export function parseConfigText(input: string, root: string): ParsedConfig {
  const warnings: string[] = [];
  const text = input.replace(/^\uFEFF/, "");
  if (!text.trim()) { warnings.push("config.txt is empty; defaults are used"); return { config: finish({}, root), warnings }; }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) { warnings.push("config.txt does not look like a text file; defaults are used"); return { config: finish({}, root), warnings }; }
  const sections: Record<string, ConfigSection> = {};
  const lines = text.split(/\r?\n/);
  let current: string | undefined, open = false;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (!line || line.startsWith("//")) continue;
    if (!current) {
      const header = /^([A-Za-z_]\w*)\s*:\s*(?:\/\/.*)?$/.exec(line);
      if (header) { current = header[1]!; open = false; sections[current] ??= {}; } else warnings.push(`line ${n + 1}: unexpected text outside a section`);
      continue;
    }
    if (!open) {
      if (line === "{") open = true; else { warnings.push(`line ${n + 1}: expected "{" after section ${current}`); current = undefined; n--; }
      continue;
    }
    if (line.startsWith("}")) { current = undefined; continue; }
    const entry = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(line);
    if (!entry) { warnings.push(`line ${n + 1}: ignored unrecognized entry`); continue; }
    const key = entry[1]!;
    let rest = entry[2]!, value: string | undefined;
    if (rest.startsWith("[[")) {
      let joined = rest.slice(2), end = joined.indexOf("]]");
      for (let k = n + 1; end < 0 && k < lines.length && k < n + 64; k++) { joined += "\n" + lines[k]; end = joined.indexOf("]]"); if (end >= 0) n = k; }
      if (end >= 0) value = joined.slice(0, end).trim();
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end >= 0) value = rest.slice(1, end);
    } else {
      const comment = rest.indexOf("//");
      if (comment >= 0) rest = rest.slice(0, comment);
      value = rest.trim();
    }
    if (value === undefined) { warnings.push(`line ${n + 1}: unterminated value for ${key}`); continue; }
    sections[current]![key] = current === "workspace" ? value : typed(value);
  }
  if (current) warnings.push(`section ${current} is not closed`);
  return { config: finish(sections, root), warnings };
}

/** Read and parse a config file without ever writing to it. */
export function readConfigFile(file: string, root: string): ParsedConfig {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("not a regular file within the size limit");
    return parseConfigText(fs.readFileSync(file, "utf8"), root);
  } catch (error) {
    const parsed = parseConfigText("", root);
    parsed.warnings = [`could not read ${file}: ${error instanceof Error ? error.message : String(error)}; defaults are used`];
    return parsed;
  }
}

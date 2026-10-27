import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { KNOWN_TOOL_NAMES, TOOLSETS, resolveToolPolicy, selectedToolsets, shouldRegisterTool, enrichToolResult } from "../src/toolPolicy.js";

const snapshot = JSON.parse(fs.readFileSync(new URL("./snapshots/tool-names.json", import.meta.url), "utf8")) as string[];

test("source module registrations match the complete policy and snapshot counts", () => {
  const names: string[] = [];
  const src = new URL("../src/", import.meta.url);
  for (const file of fs.readdirSync(src).filter(file => file.endsWith(".ts"))) {
    const source = fs.readFileSync(new URL(file, src), "utf8");
    // Registration declarations use name as their first property; palette imports
    // are the one catalog helper that takes literal names instead of definitions.
    for (const match of source.matchAll(/\b(?:register|registerTool)\s*\(\s*\{\s*name:\s*["']([a-z_0-9]+)["']/g)) names.push(match[1]!);
    for (const match of source.matchAll(/\bpaletteImport\s*\(\s*["']([a-z_0-9]+)["']/g)) names.push(match[1]!);
  }
  assert.equal(new Set(names).size, names.length, "source must not register duplicate tool names");
  assert.deepEqual(names.sort(), [...snapshot].sort());
  assert.deepEqual(names, [...KNOWN_TOOL_NAMES].sort());
});

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

test("JSON objects gain matching structuredContent without changing text or metadata", () => {
  const result: CallToolResult = { ...textResult('{"count":2,"nested":{"valid":true}}'), _meta: { trace: "kept" }, isError: false };
  const enriched = enrichToolResult(result);
  assert.deepEqual(enriched.structuredContent, { count: 2, nested: { valid: true } });
  assert.strictEqual(enriched.content, result.content);
  assert.strictEqual(enriched._meta, result._meta);
  assert.equal(enriched.isError, false);
  assert.equal(result.structuredContent, undefined, "caller input must not be mutated");
  assert.equal(enriched.content.length, result.content.length);
  assert.equal("outputSchema" in enriched, false);
});

test("JSON arrays gain an object items envelope, including empty arrays", () => {
  for (const items of [[], [1, "two", null, { nested: true }]]) {
    const result = textResult(JSON.stringify(items));
    const enriched = enrichToolResult(result);
    assert.deepEqual(enriched.structuredContent, { items });
    assert.strictEqual(enriched.content, result.content);
    assert.equal(enriched.content.length, 1);
  }
});

test("primitives, invalid JSON, plain text and empty content are unchanged", () => {
  for (const text of ["null", "true", "false", "1", "0", '"text"', "{broken}", "plain text", "", "undefined"]) {
    const result = textResult(text);
    assert.strictEqual(enrichToolResult(result), result, text);
  }
  const empty: CallToolResult = { content: [] };
  assert.strictEqual(enrichToolResult(empty), empty);
});

test("errors and preexisting structuredContent are preserved exactly", () => {
  const error: CallToolResult = { ...textResult('{"error":"failed"}'), isError: true };
  assert.strictEqual(enrichToolResult(error), error);
  for (const structuredContent of [{ authoritative: true }, null]) {
    const result: CallToolResult = { ...textResult('{"other":true}'), structuredContent };
    assert.strictEqual(enrichToolResult(result), result);
  }
});

test("images and mixed responses are preserved; multiple text payloads stay unambiguous", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
  const imageOnly: CallToolResult = { content: [image] };
  assert.strictEqual(enrichToolResult(imageOnly), imageOnly);
  const mixed: CallToolResult = { content: [image, { type: "text", text: '{"rendered":true}' }] };
  const enriched = enrichToolResult(mixed);
  assert.deepEqual(enriched.structuredContent, { rendered: true });
  assert.strictEqual(enriched.content, mixed.content);
  assert.equal(enriched.content.length, 2);
  assert.strictEqual(enriched.content[0], image);
  const multiple: CallToolResult = { content: [{ type: "text", text: '{"one":1}' }, { type: "text", text: '{"two":2}' }] };
  assert.strictEqual(enrichToolResult(multiple), multiple);
});

test("unset and whitespace-only toolsets preserve the complete catalog", () => {
  for (const env of [{}, { MAGICVOXEL_MCP_TOOLSETS: "" }, { MAGICVOXEL_MCP_TOOLSETS: " \t\n" }]) {
    const selection = selectedToolsets(env);
    assert.equal(selection, undefined);
    assert.equal(snapshot.filter(name => shouldRegisterTool(name, selection)).length, snapshot.length);
  }
});

test("subset parsing trims, deduplicates and always includes core", () => {
  assert.deepEqual(selectedToolsets({ MAGICVOXEL_MCP_TOOLSETS: " palette, shaders,palette " }), new Set(["core", "palette", "shaders"]));
  assert.deepEqual(selectedToolsets({ MAGICVOXEL_MCP_TOOLSETS: "core" }), new Set(["core"]));
  assert.deepEqual(new Set(TOOLSETS), new Set(["core", "modeling", "scene", "animation", "palette", "formats", "shaders", "app"]));
});

test("invalid groups including empty comma entries fail explicitly", () => {
  for (const value of ["all", "unknown", "scene,typo", "Scene", "scene,", ",scene", "scene,,palette", ","]) {
    assert.throws(() => selectedToolsets({ MAGICVOXEL_MCP_TOOLSETS: value }), /Unknown toolset/, value);
  }
});

test("optional groups do not implicitly enable other optional groups", () => {
  for (const group of TOOLSETS) {
    const selection = selectedToolsets({ MAGICVOXEL_MCP_TOOLSETS: group });
    const actual = snapshot.filter(name => shouldRegisterTool(name, selection));
    const expected = snapshot.filter(name => ["core", group].includes(resolveToolPolicy(name).toolset));
    assert.deepEqual(actual, expected, group);
    assert.ok(actual.includes("create_model"));
    assert.ok(actual.includes("load_vox"));
    assert.ok(actual.includes("save_vox"));
  }
  assert.equal(resolveToolPolicy("animation_to_scene").toolset, "scene");
  assert.equal(resolveToolPolicy("inspect_scene_animation").toolset, "scene");
  assert.equal(resolveToolPolicy("add_frame").toolset, "animation");
  assert.equal(shouldRegisterTool("create_model", new Set()), true);
  assert.equal(shouldRegisterTool("fill_box", new Set(["palette"])), false);
  for (const selection of [undefined, new Set(["core"]), new Set(["app"])]) {
    assert.throws(() => shouldRegisterTool("future_tool", selection), /Unknown tool/);
  }
});

test("every catalog tool has an explicit policy, with no extra or duplicate entries", () => {
  assert.equal(new Set(KNOWN_TOOL_NAMES).size, KNOWN_TOOL_NAMES.length);
  assert.deepEqual([...KNOWN_TOOL_NAMES].sort(), [...snapshot].sort());
  for (const name of snapshot) {
    const policy = resolveToolPolicy(name);
    assert.equal(typeof policy.toolset, "string", name);
    assert.equal(typeof policy.readOnly, "boolean", name);
    assert.ok(Array.isArray(policy.effects), name);
    if (policy.readOnly) assert.ok(policy.effects.every(effect => effect === "file-read"), name);
  }
});

test("unknown names fail closed rather than inheriting prefix or prototype policies", () => {
  for (const name of ["future_tool", "get_future_tool", "export_future_tool", "constructor", "__proto__", ""]) {
    assert.throws(() => resolveToolPolicy(name), /Unknown tool/, name);
  }
});

test("effects distinguish file writes, memory writes, clipboard writes and live input", () => {
  assert.deepEqual(resolveToolPolicy("copy_region").effects, ["clipboard-write"]);
  assert.equal(resolveToolPolicy("copy_region").readOnly, false);
  assert.deepEqual(resolveToolPolicy("fill_box").effects, ["model-mutation"]);
  assert.deepEqual(resolveToolPolicy("set_scene_camera_pose").effects, ["scene-mutation"]);
  assert.deepEqual(resolveToolPolicy("add_frame").effects, ["animation-mutation"]);
  assert.deepEqual(resolveToolPolicy("save_vox").effects, ["file-write"]);
  assert.deepEqual(resolveToolPolicy("export_native_render").effects, ["app-input", "file-write"]);
  assert.deepEqual(resolveToolPolicy("open_in_magicavoxel").effects, ["file-read", "app-launch"]);
  assert.deepEqual(resolveToolPolicy("attach_magicavoxel_app").effects, ["session-mutation"]);
  assert.deepEqual(resolveToolPolicy("render_model").effects, []);
});

test("file field policy records direction and directories without name heuristics", () => {
  assert.deepEqual(resolveToolPolicy("export_native_render").pathFields, { path: { access: "write" } });
  assert.deepEqual(resolveToolPolicy("export_animation_frames").pathFields, { folder: { access: "write", directory: true } });
  assert.deepEqual(resolveToolPolicy("multi_view_to_voxel").pathFields, {
    frontPath: { access: "read" }, sidePath: { access: "read" }, topPath: { access: "read" },
  });
  assert.deepEqual(resolveToolPolicy("list_xs_shaders").pathFields, { subdir: { access: "read", directory: true } });
  assert.deepEqual(resolveToolPolicy("run_xs_shader").pathFields, { path: { access: "read" } });
  assert.equal(resolveToolPolicy("fill_box").pathFields, undefined);
  for (const name of snapshot) {
    const policy = resolveToolPolicy(name);
    for (const field of Object.values(policy.pathFields ?? {})) {
      assert.ok(policy.effects.includes(field.access === "write" ? "file-write" : "file-read"), name);
      if (field.access === "write") assert.equal(policy.readOnly, false, name);
    }
  }
});

test("resolved policy copies cannot corrupt subsequent registrations", () => {
  const policy = resolveToolPolicy("save_vox");
  policy.effects.push("corrupt");
  policy.pathFields!.path!.access = "read";
  assert.deepEqual(resolveToolPolicy("save_vox").effects, ["file-write"]);
  assert.equal(resolveToolPolicy("save_vox").pathFields!.path!.access, "write");
});

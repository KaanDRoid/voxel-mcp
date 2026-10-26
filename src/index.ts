#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { MagicaConfig } from "./magicaConfig.js";
import { ModelRegistry } from "./model.js";
import { createTools } from "./tools.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

async function main() {
  const server = new McpServer({ name: "magicvoxel-mcp", version });
  const config = new MagicaConfig(process.env.MAGICAVOXEL_PATH);
  const registry = new ModelRegistry();
  createTools(server, registry, config);
  await server.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
  }
}

main().catch((error: unknown) => {
  console.error("magicvoxel-mcp:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

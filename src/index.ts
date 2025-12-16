import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { MagicaConfig } from "./magicaConfig.js";
import { ModelRegistry } from "./model.js";
import { createTools } from "./tools.js";

async function main() {
  const server = new McpServer(
    { name: "magica-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, logging: {} } }
  );

  const config = new MagicaConfig();
  const registry = new ModelRegistry();

  createTools(server, registry, config);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

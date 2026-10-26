import assert from 'node:assert/strict';
import type { z } from 'zod';
import { ModelRegistry } from '../../src/model.js';
import { registerSceneTools } from '../../src/sceneTools.js';

type Handler = (args: never) => Promise<{ content: { text: string }[] }>;
/** Runs the scene tool handlers in-process (schema parsing included) without the stdio transport. */
export function harness() {
  const registry = new ModelRegistry();
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler }>();
  registerSceneTools(((def: { name: string; inputSchema: z.ZodObject<z.ZodRawShape> }, handler: Handler) => { tools.set(def.name, { schema: def.inputSchema, handler }); }) as never, registry);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name); assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.handler(tool.schema.parse(args) as never);
    return JSON.parse(result.content[0]!.text);
  };
  return { registry, call, tools };
}

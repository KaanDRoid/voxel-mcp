declare module '@modelcontextprotocol/sdk/server/mcp' {
  export class McpServer {
    server: any;
    constructor(info: { name: string; version: string }, options?: any);
    connect(transport: any): Promise<void>;
    close(): Promise<void>;
    tool(...args: any[]): any;
    registerTool(...args: any[]): any;
    resource(...args: any[]): any;
    registerResource(...args: any[]): any;
    registerPrompt(...args: any[]): any;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio' {
  export class StdioServerTransport {
    constructor(...args: any[]);
  }
}

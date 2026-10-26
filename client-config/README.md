# MCP client configuration

1. Install Node.js 22 or newer, then run `npm ci` and `npm run build` in the repository.
2. Create a dedicated workspace directory for input files and exported assets.
3. Copy the `mcpServers` entry from `claude-desktop.json` into your client's MCP configuration.
4. Replace both example paths with absolute paths on your machine. The server entry point and workspace need not be in the same directory.
5. Restart the client and check that `create_model`, `render_model`, and `save_vox` appear in its tool list.

Use forward slashes in Windows JSON paths, or escape backslashes. On Linux and macOS use paths such as `/home/user/magicvoxel-mcp/dist/index.js`.

The configuration does not depend on a client-specific `cwd` property. Relative tool paths resolve against `MAGICVOXEL_MCP_WORKSPACE`; files outside that directory are rejected.

MagicaVoxel is optional. To enable `open_in_magicavoxel`, add `MAGICAVOXEL_PATH` to `env` with the absolute path to your trusted `MagicaVoxel.exe` or `MagicaVoxel` executable. The server does not download or install MagicaVoxel.



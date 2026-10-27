# Local source installation and MCP configuration

This server runs locally over stdio. A GitHub checkout and a Node.js build are sufficient: no npm account, npm publication, or globally installed server package is required. MagicaVoxel is optional for file-based modeling and conversion.

## 1. Get and build the source

Install Git and Node.js **22.2 or newer**, including npm. Clone the repository into a location you control:

```sh
git clone https://github.com/KaanDRoid/voxel-mcp.git
cd voxel-mcp
npm ci
npm run build
```

For an existing local checkout, open a terminal in that checkout and run:

```sh
npm ci
npm run build
```

The build creates `dist/index.js`. Keep the checkout, `dist`, and `node_modules` together. Re-run `npm ci` and `npm run build` after updating the source. Do not rely on a published npm package or point a production client at `src/index.ts`.

## 2. Create a workspace and configure the client

Create a dedicated, existing directory for input files and exported assets, separate from the MagicaVoxel installation. In a client supporting `mcpServers`, merge this entry into its MCP configuration, preserving your other servers:

```json
{
  "mcpServers": {
    "magicvoxel": {
      "command": "node",
      "args": ["C:/Projects/voxel-mcp/dist/index.js"],
      "env": {
        "MAGICVOXEL_MCP_WORKSPACE": "C:/VoxelWorkspace"
      }
    }
  }
}
```

Replace both example paths with **absolute paths on your machine**. Use forward slashes in Windows JSON, or escape backslashes. On Linux/macOS, use your actual paths, such as `/home/you/Projects/voxel-mcp/dist/index.js` and `/home/you/VoxelWorkspace`. If the client cannot find `node`, replace `command` with the verified absolute path to your Node executable, for example `C:/Program Files/nodejs/node.exe` only if that file exists on your system.

The configuration location and outer format depend on your client; use its documented MCP settings mechanism. No client-specific `cwd` field is needed or assumed. Relative tool file arguments resolve against `MAGICVOXEL_MCP_WORKSPACE`, not the checkout or client launch directory. Set this variable explicitly: if omitted, the server defaults to its process working directory. Symlink/junction targets and file size limits are checked too.

Restart or reconnect the client and check that `create_model`, `render_model`, and `save_vox` appear. For a smoke workflow, create a model, add voxels, render it, and save a `.vox` inside the workspace. Running `node /absolute/path/to/dist/index.js` in an ordinary terminal may appear to wait: this is a stdio protocol server, not an interactive shell or web server.

## 3. Optional installation assets

The server does not download or install MagicaVoxel. With a complete, trusted installation already present, add the following to the same `env` object:

```json
{
  "MAGICVOXEL_MCP_WORKSPACE": "C:/VoxelWorkspace",
  "MAGICAVOXEL_HOME": "C:/Apps/MagicaVoxel"
}
```

Alternatively, set `MAGICAVOXEL_PATH` to the absolute executable path, for example `C:/Apps/MagicaVoxel/MagicaVoxel.exe`. The executable path takes precedence when both are set. The installation needs `config/config.txt` and the `vox`, `palette`, `shader`, and `ibl` folders. Restart the server after changing settings.

Use `get_magicavoxel_info` to check discovery, followed by `list_magicavoxel_samples` or `list_magicavoxel_palettes`. Installation assets are read-only and restricted to approved folders and file types. Export to the workspace, not the installation. Configuring the installation does not launch it; `open_in_magicavoxel` is a separate, explicit launch action.

Select palettes by the **name returned by `list_magicavoxel_palettes`**, without a `.png` extension or a path. These examples use illustrative names and model IDs; substitute actual listed names and existing model IDs:

- `load_magicavoxel_palette`: `{ "name": "pal0" }` returns the installed palette without changing any model.
- `apply_magicavoxel_palette`: `{ "id": "1", "name": "pal0", "mode": "recolor" }` replaces colors while keeping voxel indices.
- Choose `"mode": "nearest"` explicitly to remap indices to the closest target RGB colors. Ties select the lowest index, alpha is ignored for distance, and index zero is never selected for an occupied voxel.

Palettes contain 256 unsigned packed `0xAABBGGRR` values indexed by voxel index. PNG slot zero maps to voxel index one; slot 255 maps to reserved index zero. Neither palette tool writes to the installed PNG.

## 4. Optional live UI control and safety

Live control is separate from offline tools and disabled by default. On Windows, enable it deliberately with `"MAGICVOXEL_MCP_UI_AUTOMATION": "1"` in `env`, configure the trusted installation, and restart the server. The calibrated version is **0.99.7.2**; do not bypass version checks casually.

Save your work, start the trusted application yourself, then call `attach_magicavoxel_app` to pin the intended process before camera or native-render operations. Keep the application in the foreground and avoid mouse/keyboard input during automation. Identity and foreground checks reduce risk but cannot make global input atomic. Live UI changes are not covered by model-registry undo. Leave the switch unset when you only need file tools, scenes, palettes, or software previews.

## Troubleshooting

- **Startup failure:** verify `node --version`, the absolute entry point, and successful `npm ci`/`npm run build` in that checkout. Read the client's server stderr log.
- **Node not found:** GUI clients may have a different `PATH`; use the verified absolute Node executable path.
- **File outside workspace:** move the input into the workspace or select a listed installation asset with its convenience tool. Do not broaden the workspace to your whole disk just to avoid the restriction.
- **Installation unavailable:** check the installation environment variables, required folders, and executable-path precedence. Offline modeling does not require installation discovery.
- **Live control disabled:** check Windows support, explicit opt-in, application version, and process attachment. UI opt-in is not needed to load installed palettes.



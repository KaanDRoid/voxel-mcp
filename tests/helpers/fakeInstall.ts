import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const README = '[MagicaVoxel : 8-bit Voxel Editor & Renderer created by ephtracy]\r\n================================\r\ndate    : 10/31/2025\r\n\r\nversion : 0.99.7.2\r\n\r\nos      : win64\r\n';

export const CONFIG = `workspace :
{
    // use '$' for current directory, otherwise use actual full path
    dir_model      : [[$/vox]]
    dir_palette    : [[$/palette]]
    dir_xs_shader  : [[$/shader]]
    dir_ibl        : [[$/ibl]]
    rename_prefix   : '-'
    rename_suffix   : ''
}

io_obj :
{
    scale   : '0.1'
    axis    : 'XZ-Y' // axis : { 'XYZ' : Z up; 'XZ-Y' Y up }
    cw      : '0'
    merge   : '1'
}
`;

/** Build a synthetic installation folder (never the real application). */
export function makeFakeInstall(options: { skip?: string[]; readme?: string; config?: string } = {}): { root: string; exe: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-magicavoxel-')));
  const skip = new Set(options.skip ?? []);
  for (const dir of ['config', 'vox', 'vox/anim', 'palette', 'shader', 'ibl', 'cache', 'export']) if (!skip.has(dir)) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const exe = path.join(root, 'MagicaVoxel.exe');
  fs.writeFileSync(exe, 'not a real executable');
  if (!skip.has('readme.txt')) fs.writeFileSync(path.join(root, 'readme.txt'), options.readme ?? README);
  if (!skip.has('config') && !skip.has('config.txt')) fs.writeFileSync(path.join(root, 'config', 'config.txt'), options.config ?? CONFIG);
  if (!skip.has('shader')) fs.writeFileSync(path.join(root, 'shader', 'round.txt'), 'xs_begin');
  if (!skip.has('ibl')) fs.writeFileSync(path.join(root, 'ibl', 'sky.hdr'), 'hdr');
  fs.writeFileSync(path.join(root, 'cache', 'backup.vox'), 'private');
  return { root, exe, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

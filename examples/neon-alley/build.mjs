// Builds "Neon Alley" through the magicvoxel-mcp stdio server and saves neon-alley-night.vox next to this file.
// Run from the repository root after `npm run build`:  node examples/neon-alley/build.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = fileURLToPath(new URL('.', import.meta.url));
const server = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const colors = [null,[18,22,37],[40,48,67],[54,71,91],[62,46,76],[80,86,104],[24,30,43],[88,106,122],[31,91,101],[10,15,27],[26,235,241],[255,48,156],[255,172,64],[156,233,255],[137,87,255],[242,173,100],[63,138,169],[154,44,66],[177,190,200],[144,168,176],[35,58,77],[37,95,113],[91,44,91],[192,91,41],[179,121,91],[33,68,98],[39,43,68],[161,108,77],[52,98,85],[29,57,69],[65,80,97],[98,76,119],[209,129,183]];
const act = Buffer.alloc(768); for (let i=1;i<256;i++) act.set(colors[i] ?? colors[1], (i-1)*3);
fs.writeFileSync(path.join(here, 'neon-alley.act'), act);
const vox = new Map();
const put=(x,y,z,i)=>{ x=Math.round(x);y=Math.round(y);z=Math.round(z);if(x>=0&&x<160&&y>=0&&y<128&&z>=0&&z<112)vox.set(x+160*(y+128*z),{x,y,z,i});};
const box=(x0,y0,z0,x1,y1,z1,i)=>{for(let z=z0;z<=z1;z++)for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)put(x,y,z,i);};
const line=(a,b,i)=>{const n=Math.max(...a.map((v,k)=>Math.abs(v-b[k])));for(let j=0;j<=n;j++)put(...a.map((v,k)=>v+(b[k]-v)*(n?j/n:0)),i);};
const shell=(x0,y0,z0,x1,y1,z1,i)=>{box(x0,y0,z0,x1,y0+1,z1,i);box(x0,y1-1,z0,x1,y1,z1,i);box(x0,y0,z0,x0+1,y1,z1,i);box(x1-1,y0,z0,x1,y1,z1,i);box(x0,y0,z1-1,x1,y1,z1,i);};
const letters={A:['010','101','111','101','101'],B:['110','101','110','101','110'],C:['011','100','100','100','011'],D:['110','101','101','101','110'],E:['111','100','110','100','111'],F:['111','100','110','100','100'],H:['101','101','111','101','101'],I:['111','010','010','010','111'],L:['100','100','100','100','111'],M:['101','111','111','101','101'],N:['101','111','111','111','101'],O:['111','101','101','101','111'],P:['110','101','110','100','100'],R:['110','101','110','101','101'],S:['011','100','010','001','110'],T:['111','010','010','010','010'],U:['101','101','101','101','111'],V:['101','101','101','101','010'],X:['101','101','010','101','101'],Y:['101','101','010','010','010'],0:['111','101','101','101','111'],2:['110','001','010','100','111'],4:['101','101','111','001','001'],7:['111','001','010','010','010'],' ':['000','000','000','000','000']};
function text(s,x,y,z,i,plane='front',scale=1){for(let k=0;k<s.length;k++){const glyph=letters[s[k]]??letters[' '];for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(glyph[row][col]==='1')for(let a=0;a<scale;a++)for(let b=0;b<scale;b++){const u=k*4*scale+col*scale+a,v=(4-row)*scale+b;plane==='front'?put(x+u,y,z+v,i):put(x,y+u,z+v,i);}}}
// Street surface: subtle wet patches and lane markings, not emissive fake reflections.
for(const [cx,cy,rx,ry,col]of [[66,32,11,4,20],[87,17,9,3,21],[94,81,8,5,22],[65,91,12,3,20],[83,112,10,3,21]])for(let x=cx-rx;x<=cx+rx;x++)for(let y=cy-ry;y<=cy+ry;y++)if(((x-cx)/rx)**2+((y-cy)/ry)**2<1)put(x,y,4,col);
for(let y=7;y<120;y+=14)box(76,y,4,77,y+5,4,19);
for(let x=53;x<101;x+=7)box(x,22,4,x+3,28,4,18);
for(let y=0;y<128;y+=8){box(45,y,6,46,y+3,6,7);box(104,y,6,105,y+3,6,7);}
for(let t=0;t<9;t++){put(84+t,39,4,7);put(84+t,45,4,7);}for(let x=85;x<92;x+=2)box(x,40,4,x,44,4,9);
// Tall hotel. The shell is hollow, with modeled cornices and warm/cool window bays.
shell(7,24,7,43,101,98,2);
for(const z of [25,44,63,82,98]){box(6,23,z,44,102,z+1,3);box(9,26,z+2,41,99,z+2,2);}
for(let x=9;x<=41;x+=8)box(x,22,8,x+1,95,8,30);
for(const z of [32,51,70,89])for(const x of [13,29]){box(x-1,21,z-1,x+9,22,z+10,9);box(x,20,z,x+7,21,z+8,29);box(x+1,20,z+1,x+3,20,z+7,((x+z)%3===0)?15:16);box(x+4,19,z,x+4,20,z+8,7);box(x-2,19,z-2,x+10,22,z-2,7);}
for(const z of [34,53,72,89])for(const y of [31,49,67,85]){box(44,y-1,z-1,45,y+9,z+9,9);box(45,y,z,45,y+7,z+7,29);box(46,y+1,z+1,46,y+3,z+6,(y+z)%4===0?15:16);box(46,y+4,z,46,y+4,z+7,7);box(44,y-2,z-2,47,y+10,z-2,30);}
// Recessed entry, striped awning and shop sign.
box(13,21,7,35,23,25,9);box(16,20,8,31,20,23,29);box(23,19,9,23,20,22,7);box(28,19,14,29,19,15,12);
box(9,16,26,40,23,28,8);for(let x=10;x<40;x+=5)box(x,15,26,x+1,22,27,3);
box(11,20,29,39,22,38,9);text('NOVA',17,19,31,10);
// Blade sign on the street-facing facade.
box(44,30,45,49,42,87,9);box(50,30,45,50,30,87,10);box(50,42,45,50,42,87,10);box(50,31,87,50,41,87,10);
for(let k=0;k<5;k++)text('HOTEL'[k],51,34,77-k*6,11,'side');
// Mechanical detail, service pipes and roof furniture.
line([46,65,9],[46,65,93],7);line([47,67,11],[47,67,82],8);line([47,67,82],[50,67,82],7);
for(const y of [48,78]){box(45,y,17,50,y+9,24,30);for(let q=0;q<4;q++)box(51,y+1+q*2,18,51,y+1+q*2,23,9);}
box(12,69,99,26,85,104,30);box(14,71,105,24,83,107,7);for(let y=73;y<=81;y+=2)box(15,y,108,23,y,108,9);
line([32,83,99],[32,83,110],7);line([26,83,107],[38,83,107],7);line([28,83,104],[36,83,104],7);
for(let y=27;y<100;y+=8){box(8,y,99,8,y,102,7);box(42,y,99,42,y,102,7);}line([8,26,102],[8,100,102],7);line([42,26,102],[42,100,102],7);
// Background buildings terminate the alley without hiding the two storefronts.
shell(60,108,7,100,124,69,4);for(const z of[27,47,68])box(59,107,z,101,125,z+1,31);
for(let x=65;x<100;x+=11)for(const z of[34,54]){box(x,106,z,x+6,107,z+9,9);box(x+1,105,z+1,x+4,105,z+7,16);}
box(68,105,8,95,107,28,30);for(let z=10;z<28;z+=3)box(69,104,z,94,104,z,7);text('07',78,103,17,12);
box(64,104,73,97,110,84,9);text('NEON',68,103,77,14);line([65,105,72],[65,105,69],7);line([95,105,72],[95,105,69],7);
shell(112,66,7,152,116,72,3);for(const z of[29,49,72])box(111,65,z,153,117,z+1,30);
for(const z of[35,55])for(let x=117;x<=145;x+=12){box(x,64,z,x+7,65,z+9,9);box(x+1,63,z+1,x+5,63,z+7,(x+z)%3?15:16);}
box(117,62,17,146,65,28,9);text('RX',126,61,20,10, 'front',1);box(147,63,20,150,63,21,10);box(148,63,19,149,63,22,10);
box(121,84,73,138,101,78,30);for(let x=123;x<138;x+=3)box(x,86,79,x,99,79,9);
// Corner noodle bar, open counter, striped canopy, little bowls and stools.
shell(112,22,7,151,55,32,4);box(116,20,12,147,22,25,9);box(118,21,14,145,21,24,27);
box(115,15,15,148,22,17,27);box(115,14,15,148,14,15,7);box(117,20,23,146,20,24,15);
box(110,14,28,153,24,30,8);for(let x=112;x<152;x+=6)box(x,14,28,x+2,23,29,3);box(110,13,27,153,13,27,10);
box(115,21,33,149,24,42,9);text('NOODLE',120,20,35,12);
for(const x of [120,129,138,147]){box(x,10,7,x+1,11,12,7);box(x-1,9,13,x+2,12,13,23);box(x-1,17,18,x+1,19,18,18);put(x,18,19,12);line([x,18,19],[x+2,18,21],7);}
for(const x of[117,146]){line([x,18,25],[x,18,22],7);box(x-1,17,19,x+1,19,22,11);put(x,18,23,7);}
box(125,39,33,139,50,39,30);for(let x=127;x<139;x+=2)box(x,40,40,x,49,40,9);line([145,46,33],[145,46,47],7);box(143,44,47,147,48,48,30);
// Vending machine, dumpster, crates, vents and planter.
box(48,81,7,55,89,25,3);box(56,82,11,56,88,23,9);box(57,83,14,57,86,21,10);box(57,87,12,57,87,17,12);box(56,83,9,57,87,10,9);
box(146,6,7,155,13,14,8);box(145,5,15,156,14,16,30);for(let x=147;x<155;x+=3)box(x,5,10,x,5,13,7);
for(const [x,y] of[[51,95],[106,92],[9,9]]){box(x,y,7,x+6,y+6,11,27);box(x+1,y+1,12,x+5,y+5,12,28);for(let j=0;j<9;j++)put(x+1+(j*3)%5,y+1+(j*2)%5,13+j%3,28);}
for(const [x,y]of[[100,67],[151,59]]){box(x,y,7,x+4,y+4,12,23);line([x,y,8],[x+4,y,12],7);line([x+4,y,8],[x,y,12],7);}
// A compact service taxi, with readable body/glass/lamp separation.
box(77,53,7,93,73,9,9);box(76,53,10,94,72,12,23);box(78,56,13,92,69,14,23);box(80,59,15,90,68,18,29);box(80,59,19,90,68,19,3);box(84,61,20,87,64,20,12);
box(78,52,10,81,52,11,13);box(89,52,10,92,52,11,13);box(79,74,10,81,74,11,11);box(90,74,10,92,74,11,11);for(const x of[75,94])for(const y of[56,69])box(x,y,7,x,y+2,10,9);
// Umbrella pedestrian: silhouette, not a large generated character asset.
box(59,57,7,59,58,12,9);box(62,57,7,62,58,12,9);box(58,56,13,63,59,18,25);box(60,57,19,62,59,21,24);line([64,58,14],[64,58,25],7);
for(let dx=-7;dx<=7;dx++)for(let dy=-7;dy<=7;dy++){const r=Math.sqrt(dx*dx+dy*dy);if(r<=7)put(61+dx,58+dy,25-Math.floor(r*.4),(dx+dy)%4===0?14:26);}
// Street light and draped cables with colored lanterns.
box(101,10,7,102,11,45,7);line([88,10,46],[102,10,46],7);box(87,9,44,95,12,45,9);box(88,10,43,94,11,43,13);
for(const y of[46,91])for(let j=0;j<=67;j++){const x=45+j,z=Math.round(66-9*Math.sin(Math.PI*j/67));put(x,y,z,9);if(j>0&&j<67&&j%12===0){line([x,y,z-1],[x,y,z-3],7);box(x-1,y-1,z-6,x+1,y+1,z-3,j%24===0?12:11);}}
// Sidewalk tactile strips, bollards, litter and small facade wear.
for(let y=4;y<124;y+=5){box(43,y,6,43,y+1,6,19);box(107,y,6,107,y+1,6,19);}
for(const [x,y]of[[49,10],[103,32],[49,70],[104,108]]){box(x,y,7,x+1,y+1,13,7);box(x,y,11,x+1,y+1,12,12);}
for(let j=0;j<65;j++){const x=8+(j*17)%32,z=9+(j*11)%81;put(x,21,z,j%2?3:4);}
for(let j=0;j<15;j++)put(48+(j*19)%53,5+(j*31)%117,5,j%2?18:27);

const client = new Client({ name: 'neon-alley-example', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: here, env: { ...process.env, MAGICVOXEL_MCP_WORKSPACE: here }, stderr: 'pipe' });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(c => c.type === 'text');
  if (!block) return result;
  try { return JSON.parse(block.text); } catch { return block.text; }
};

// Native render dictionaries. Values are the strings MagicaVoxel stores in the file; they are not physical units.
const render = {
  _bounce: { _diffuse: '4', _specular: '6', _scatter: '4', _energy: '3' },
  _env: { _mode: '0' },
  _inf: { _i: '0.26', _k: '155 175 235', _angle: '38 130', _area: '0.25', _disk: '0' },
  _uni: { _i: '0.42', _k: '125 145 185' },
  _fog_uni: { _d: '0', _k: '80 95 140', _g: '0.2' },
  _lens: { _proj: '0', _fov: '38', _aperture: '0', _blade_n: '0', _blade_r: '0' },
  _film: { _expo: '1.3', _vig: '0.12', _aces: '1', _gam: '2.2' },
  _bloom: { _mix: '0.16', _scale: '0.05', _aspect: '0', _threshold: '0.8' },
  _ground: { _color: '14 18 29', _hor: '0.1' },
  _bg: { _color: '9 13 25' },
  _setting: { _ground: '1', _grid: '0', _edge: '0', _bg_c: '1', _bg_a: '0', _scale: '1 1 1', _cell: '1' },
};

try {
  await client.connect(transport);
  const { id } = await call('create_model', { sizeX: 160, sizeY: 128, sizeZ: 112 });
  await call('import_palette_act', { id, path: 'neon-alley.act' });
  for (const [x0, y0, z0, x1, y1, z1, i] of [[0, 0, 0, 159, 127, 3, 1], [0, 0, 4, 159, 127, 4, 6], [0, 0, 5, 46, 127, 6, 5], [104, 0, 5, 159, 127, 6, 5]]) await call('fill_box', { id, x0, y0, z0, x1, y1, z1, i });
  const data = [...vox.values()];
  for (let n = 0; n < data.length; n += 16000) await call('set_voxels', { id, voxels: data.slice(n, n + 16000) });
  const { sceneId } = await call('create_scene', { modelIds: [id] });
  // MagicaVoxel centers an object on its transform: lift it by half its height so the base sits on the ground plane.
  await call('set_scene_node', { sceneId, nodeId: 2, attributes: { _name: 'Neon Alley - Sector 07' }, translation: [0, 0, 56] });
  for (const index of [1, 2, 3, 4, 5, 8, 9, 17, 18, 19, 23, 24, 25, 26, 27, 28, 30, 31, 32]) await call('set_scene_material', { sceneId, index, properties: { _type: '_diffuse', _rough: index === 5 ? '0.55' : '0.72', _ior: '0.3' } });
  for (const index of [6, 7, 20, 21, 22, 29]) await call('set_scene_material', { sceneId, index, properties: { _type: '_metal', _metal: index === 7 ? '0.8' : '0.45', _rough: index === 7 ? '0.3' : '0.18', _ior: '0.3' } });
  for (const index of [10, 11, 12, 13, 14, 15, 16]) await call('set_scene_material', { sceneId, index, properties: { _type: '_emit', _emit: index >= 15 ? '0.35' : '0.8', _flux: index >= 15 ? '0' : '1', _ldr: '0', _rough: '0.3' } });
  for (const [type, properties] of Object.entries(render)) await call('set_scene_render_object', { sceneId, type, properties });
  await call('set_scene_camera', { sceneId, cameraId: 0, properties: { _mode: 'pers', _focus: '0 0 45', _angle: '0 0 0', _radius: '230', _frustum: '0.344328', _fov: '38' } });
  await call('save_scene', { sceneId, path: 'neon-alley-night.vox' });
  const info = await call('get_model_info', { id });
  console.log(JSON.stringify({ voxels: info.voxelCount, file: path.join(here, 'neon-alley-night.vox') }));
} finally { await client.close(); await transport.close(); }

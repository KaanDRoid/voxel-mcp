import test from 'node:test';
import assert from 'node:assert/strict';
import * as generators from '../src/generators.js';
import type { VoxModelData } from '../src/vox.js';
const cases: Record<string,any[]> = {
 generateHouse:[{floors:2,style:'modern'}], generateCharacter:[{style:'default'}],
 generateVehicle:['car','truck','spaceship','boat','plane','tank','motorcycle','helicopter'].map(type=>({type})),
 generateFurniture:['chair','table','bed','shelf','lamp','sofa','desk','cabinet'].map(type=>({type})),
 generateWeapon:['sword','axe','hammer','spear','bow','gun','staff','shield','dagger'].map(type=>({type})),
 generateStructure:['castle','tower','bridge','wall','gate','temple','pyramid','lighthouse'].map(type=>({type})),
 generateCreature:['dog','cat','bird','fish','dragon','horse','snake','spider','robot'].map(type=>({type})),
 generateNature:['rock','crystal','cloud','mountain','island','cave','mushroom','flower'].map(type=>({type})),
 generateCityBlock:[{}], generateVenueInterior:[{}], generateVenueCharacter:[{role:'waiter'}],
 generateStaff:['bartender','chef','cleaner','hostess','musician','security','waiter'].map(type=>({type})),
 generateCustomer:['regular','worker','elite','retiree','emotional','young','bureaucrat','undercover','farmer','gangster','foreign','vip','detective'].flatMap(type=>['standing','sitting','drinking'].map(pose=>({type,pose}))),
 generateFromPrompt:['house','cyberpunk character','sphere','tower']
};
test('all procedural generators emit deterministic unique integer cells inside 8/16/32/64 models',async()=> {
 for(const size of [8,16,32,64]) for(const [name,options] of Object.entries(cases)) for(const opts of options) {
  const run=async(seed:number)=> {
   const m:VoxModelData={sizeX:size,sizeY:size,sizeZ:size,voxels:[]};
   const fn=(generators as any)[name];
   if(name==='generateFromPrompt') await fn(m,opts,{seed}); else await fn(m,{...opts,seed});
   return m;
  };
  const m=await run(17); const label=`${name} ${JSON.stringify(opts)} size ${size}`;
  assert.ok(m.voxels.length>0,label);
  for(const v of m.voxels) assert.ok([v.x,v.y,v.z].every(n=>Number.isInteger(n)&&n>=0&&n<size)&&Number.isInteger(v.i)&&v.i>0&&v.i<256,`${label}: ${JSON.stringify(v)}`);
  assert.equal(new Set(m.voxels.map(v=>`${v.x},${v.y},${v.z}`)).size,m.voxels.length,label);
  assert.deepEqual(m,await run(17),label);
 }
});

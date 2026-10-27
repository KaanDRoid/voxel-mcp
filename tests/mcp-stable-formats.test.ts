import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('KVX and explicitly described RAW layouts work over real stdio, including undo and PLY native profile', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stable-formats-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/index.js')],cwd:root,stderr:'pipe'});
 const client=new Client({name:'stable-formats-test',version:'1.0.0'});
 try{
  await client.connect(transport);const names=(await client.listTools()).tools.map(t=>t.name);
  for(const n of ['export_kvx','import_kvx','export_raw','import_raw'])assert.ok(names.includes(n),n);
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));const text=(r.content as {text:string}[])[0]!.text;try{return JSON.parse(text);}catch{return text;}};
  const {id}=await call('create_model',{sizeX:8,sizeY:8,sizeZ:8});
  await call('set_voxels',{id,voxels:[{x:1,y:1,z:1,i:1},{x:3,y:1,z:2,i:2}]});
  for(const encoding of ['rgba8','rgb8','indexed8']){
   const output=await call('export_raw',{id,path:`out/${encoding}.raw`,encoding,order:'z-fastest'});
   const imported=await call('import_raw',{path:`out/${encoding}.raw`,...output.metadata});
   assert.equal(imported.voxels,2);assert.equal((await call('get_model_info',{id:imported.id})).voxelCount,2);
   await call('undo',{});
   const gone=await client.callTool({name:'get_model_info',arguments:{id:imported.id}});assert.equal(gone.isError,true);
  }
  await call('export_kvx',{id,path:'out/model.kvx',pivot:[1.25,-0.5,2]});
  const imported=await call('import_kvx',{path:'out/model.kvx'});assert.equal(imported.voxels,2);assert.deepEqual(imported.pivot,[1.25,-0.5,2]);
  await call('export_ply',{id,path:'out/native.ply',profile:'magica'});
  assert.match(fs.readFileSync(path.join(root,'out/native.ply'),'utf8'),/element face 12/);
  const invalid=await client.callTool({name:'import_raw',arguments:{path:'out/rgba8.raw',sizeX:1,sizeY:1,sizeZ:1,encoding:'rgba8'}});assert.equal(invalid.isError,true);
 }finally{await client.close();await transport.close();}
});

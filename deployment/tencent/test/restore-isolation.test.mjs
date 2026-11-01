import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

test('Restoring an older account catalog cannot attach an orphaned gallery to a new account',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-restore-test-'));
  const origin='http://127.0.0.1:18091';
  const password=randomBytes(18).toString('base64url');
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18091',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  let server,catalog,gallery;
  const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
  async function start(){
    server=spawn(process.execPath,['app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server failed: ${code}`)));});
  }
  async function createPhotographer(name,headers){
    const result=await request('/api/platform/invitations',{method:'POST',headers,body:JSON.stringify({count:1,days:7,quotaBytes:10000,note:'Restore test'})});
    assert.equal(result.status,201);
    const {codes}=await result.json();
    const response=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:name,displayName:name,password,passwordConfirmation:password,invitation:codes[0]})});
    assert.equal(response.status,303);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const account=(await (await request('/api/session',{headers:{Cookie:cookie}})).json()).account;
    return {account,cookie};
  }
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));assert.equal((await once(setup,'exit'))[0],0);
    await start();
    const login=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'admin',password})});
    assert.equal(login.status,303);
    const adminHeaders={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));
    const snapshot=resolve(data,'catalog-before.sqlite');await backup(catalog,snapshot);
    const old=await createPhotographer('olduser',adminHeaders);
    const oldStorage=catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(old.account.id).storage_id;
    const oldFilename=resolve(data,'photographers',oldStorage,'gallery.sqlite');
    gallery=new DatabaseSync(oldFilename);
    gallery.prepare("INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES ('old-private','scene','Old private photo','Private','/assets/scene-01.jpg','Old',1,0,?)").run(new Date().toISOString());
    gallery.close();gallery=undefined;catalog.close();catalog=undefined;
    server.kill();await once(server,'exit');
    for(const suffix of ['-wal','-shm'])await rm(resolve(data,'platform.sqlite'+suffix),{force:true});
    await copyFile(snapshot,resolve(data,'platform.sqlite'));
    await start();
    const created=await createPhotographer('newuser',adminHeaders);
    assert.equal(created.account.id,old.account.id,'The test must exercise reuse of a numeric account ID');
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));
    const newStorage=catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(created.account.id).storage_id;
    assert.notEqual(newStorage,oldStorage);
    const response=await request('/api/admin/photos',{headers:{Cookie:created.cookie}});
    assert.equal(response.status,200);assert.equal((await response.json()).photos.length,0);
    assert.equal((await request('/api/media/newuser/old-private')).status,404);
    gallery=new DatabaseSync(oldFilename);
    assert.equal(gallery.prepare('SELECT title FROM photos WHERE id=?').get('old-private').title,'Old private photo');
  }finally{
    catalog?.close();gallery?.close();
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-restore-test-'));await rm(data,{recursive:true,force:true});
  }
});

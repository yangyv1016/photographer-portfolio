import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Original downloads are owner-only attachments with safe filenames and unchanged bytes',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-download-test-'));
  const origin='http://127.0.0.1:18092';
  const password=randomBytes(18).toString('base64url');
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18092',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  const originalBytes=Buffer.from([255,216,255,0,1,127,128,254,255,217]);
  const formats=[['jpg','image/jpeg'],['png','image/png'],['webp','image/webp'],['gif','image/gif']];
  const opened=[];
  let server,catalog;
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));
    assert.equal((await once(setup,'exit'))[0],0);
    const gallery=new DatabaseSync(resolve(data,'gallery.sqlite'));opened.push(gallery);
    const insert=gallery.prepare("INSERT INTO photos (id,series,title,alt,src,image_key,photographer,is_sample,sort_order,created_at) VALUES (?,'scene',?,'Original','/assets/scene-01.jpg',?,'Owner',?,0,?)");
    for(const [extension] of formats){
      insert.run(`original-${extension}`,extension==='jpg'?'夜景 "测试"\r\n../作品?.png':`作品 '${extension}'`,'photos/original.'+extension,0,new Date().toISOString());
      gallery.prepare('INSERT INTO object_sizes VALUES (?,?)').run(`original-${extension}`,originalBytes.length);
    }
    for(const [id,title,key,sample] of [['reserved','CON','photos/reserved.jpg',0],['sample','Sample',null,1],['sample-key','Sample key','photos/sample.jpg',1],['missing-object','Missing','photos/missing.jpg',0]]){
      insert.run(id,title,key,sample,new Date().toISOString());
      if(key)gallery.prepare('INSERT INTO object_sizes VALUES (?,?)').run(id,0);
    }
    const before=gallery.prepare('SELECT * FROM photos ORDER BY id').all();
    const stub=resolve(data,'cos-fetch-stub.mjs');
    // Only the spawned test server replaces COS HTTP reads; no real COS service is contacted.
    await writeFile(stub,`const originalFetch=globalThis.fetch;
const bytes=Uint8Array.from(${JSON.stringify([...originalBytes])});
const types=new Map(${JSON.stringify(formats.map(([extension,type])=>['/photos/original.'+extension,type]).concat([['/photos/reserved.jpg','image/jpeg']]))});
globalThis.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.hostname==='test-1250000000.cos.ap-chengdu.myqcloud.com'){
  const type=types.get(url.pathname);
  if(!type)return new Response('Missing',{status:404});
  if(options?.redirect!=='error')throw new Error('COS reads must reject upstream redirects');
  return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,4));controller.enqueue(bytes.slice(4));controller.close();}}),{headers:{'Content-Type':type,'Content-Disposition':'attachment; filename="upstream.jpg"','Location':'https://upstream.invalid/private'}});
 }
 if(url.hostname.endsWith('.myqcloud.com'))throw new Error('Unexpected COS test request');
 return originalFetch(input,options);
};`);
    server=spawn(process.execPath,['--import',pathToFileURL(stub).href,'app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server failed: ${code}`)));});
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
    assert.equal((await request('/api/admin/download?id=original-jpg')).status,401);
    const login=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'admin',password})});
    assert.equal(login.status,303);
    const headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));opened.push(catalog);
    catalog.prepare('UPDATE users SET avatar_key=?,cover_key=?,directory_cover_key=? WHERE id=1').run('photos/original.png','photos/original.webp','photos/original.gif');
    const publicMedia=[['/api/media/yangyu/original-jpg','image/jpeg'],['/api/media/original-jpg','image/jpeg'],['/api/avatars/yangyu','image/png'],['/api/covers/yangyu','image/webp'],['/api/directory-covers/yangyu','image/gif']];
    for(const [path,type] of publicMedia){
      const response=await request(path);
      assert.equal(response.status,200,path);assert.equal(response.headers.get('content-type'),type);
      assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('content-disposition'),'inline');
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),originalBytes);
    }
    for(const path of ['/api/media/yangyu/sample','/api/media/yangyu/photos/original.jpg','/api/media/no-such-account/original-jpg'])assert.equal((await request(path)).status,404,path);
    assert.equal((await request('/assets/scene-01.jpg')).status,200);
    for(const id of ['unknown','sample','sample-key',"' OR 1=1 --"]){
      assert.equal((await request('/api/admin/download?id='+encodeURIComponent(id),{headers})).status,404,id);
    }
    assert.equal((await request('/api/admin/download',{headers})).status,404);
    for(const [extension,type] of formats){
      const response=await request('/api/admin/download?id=original-'+extension,{headers});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('content-type'),type);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      const disposition=response.headers.get('content-disposition');
      assert.ok(disposition.startsWith(`attachment; filename="photo.${extension}"; filename*=UTF-8''`));
      const filename=decodeURIComponent(disposition.split("filename*=UTF-8''")[1]);
      assert.ok(filename.endsWith('.'+extension));assert.ok(filename.includes('作品'));
      assert.ok(!/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),originalBytes);
    }
    const reserved=await request('/api/admin/download?id=reserved',{headers});
    assert.ok(reserved.headers.get('content-disposition').endsWith("filename*=UTF-8''photo-CON.jpg"));
    await reserved.arrayBuffer();
    const exportImage=await request('/api/admin/export-image?id=original-jpg',{headers});
    assert.equal(exportImage.status,200);assert.equal(exportImage.headers.get('content-disposition'),'inline');
    assert.equal(exportImage.headers.get('location'),null);
    assert.deepEqual(Buffer.from(await exportImage.arrayBuffer()),originalBytes);
    assert.equal((await request('/api/admin/download?id=missing-object',{headers})).status,503);
    const photos=(await (await request('/api/admin/photos',{headers})).json()).photos;
    assert.equal(photos.find(photo=>photo.id==='original-jpg').downloadSrc,'/api/admin/download?id=original-jpg');
    assert.equal(photos.find(photo=>photo.id==='sample').downloadSrc,undefined);
    const publicPage=await (await request('/yangyu')).text();
    assert.ok(!publicPage.includes('downloadSrc'));
    const invitation=await (await request('/api/platform/invitations',{method:'POST',headers,body:JSON.stringify({count:1,days:7,quotaBytes:10000,note:'Download isolation'})})).json();
    const registered=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'otheruser',displayName:'Other',password,passwordConfirmation:password,invitation:invitation.codes[0]})});
    assert.equal(registered.status,303);
    const otherHeaders={Cookie:registered.headers.get('set-cookie').split(';')[0]};
    assert.equal((await request('/api/admin/download?id=original-jpg',{headers:otherHeaders})).status,404);
    const session=await (await request('/api/session',{headers:otherHeaders})).json();
    const storage=catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(session.account.id).storage_id;
    const otherGallery=new DatabaseSync(resolve(data,'photographers',storage,'gallery.sqlite'));opened.push(otherGallery);
    otherGallery.prepare("INSERT INTO photos (id,series,title,alt,src,image_key,photographer,is_sample,sort_order,created_at) VALUES ('other-photo','scene','Other','Other','/assets/scene-01.jpg','photos/original.jpg','Other',0,0,?)").run(new Date().toISOString());
    assert.equal((await request('/api/admin/download?id=other-photo',{headers})).status,404);
    assert.equal((await request('/api/admin/export-image?id=other-photo',{headers})).status,404);
    assert.equal((await request('/api/media/otheruser/original-jpg')).status,404);
    assert.equal((await request('/api/profile',{method:'PATCH',headers,body:JSON.stringify({displayName:'Owner',publicId:'owner-renamed',bio:'',listed:true})})).status,200);
    for(const prefix of ['/api/media/','/api/avatars/','/api/covers/','/api/directory-covers/']){
      const suffix=prefix==='/api/media/'?'/original-jpg':'';
      for(const id of ['yangyu','owner-renamed'])assert.equal((await request(prefix+id+suffix)).status,200);
    }
    catalog.prepare('UPDATE users SET avatar_key=?,cover_key=?,directory_cover_key=? WHERE id=?').run('photos/original.png','photos/original.webp','photos/original.gif',session.account.id);
    assert.equal((await request('/api/platform/accounts',{method:'PATCH',headers,body:JSON.stringify({id:session.account.id,action:'disable'})})).status,200);
    for(const path of ['/api/media/otheruser/other-photo','/api/avatars/otheruser','/api/covers/otheruser','/api/directory-covers/otheruser'])assert.equal((await request(path)).status,404,path);
    assert.deepEqual(gallery.prepare('SELECT * FROM photos ORDER BY id').all(),before);
    assert.equal(catalog.prepare('SELECT quota_bytes FROM users WHERE id=1').get().quota_bytes,5*1024**3);
  }finally{
    for(const database of opened)database.close();
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-download-test-'));
    await rm(data,{recursive:true,force:true});
  }
});

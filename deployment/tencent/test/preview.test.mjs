import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

test('Local previews are real resized first-frame images with bounded caching and serial generation',{timeout:30000},async()=>{
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-preview-unit-'));
  const previous={...process.env};
  const originalFetch=globalThis.fetch;
  try{
    Object.assign(process.env,{YANGYU_ROOT:data,DATA_DIRECTORY:data,COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only',COS_SECRET_KEY:'test-only'});
    const cache=resolve(data,'previews');
    await mkdir(cache);
    for(const [name,time] of [['1',1],['2',2]]){
      const filename=resolve(cache,name.repeat(64)+'.webp');
      await writeFile(filename,'');await truncate(filename,80*1024**2);await utimes(filename,time,time);
    }
    await writeFile(resolve(cache,'3'.repeat(64)+'-'+randomUUID()+'.tmp'),'stale');
    const pixels=Buffer.alloc(1600*1000*3);
    for(let index=0;index<pixels.length;index++)pixels[index]=(index*131+(index>>8)*17)%256;
    const landscape=await sharp(pixels,{raw:{width:1600,height:1000,channels:3}}).jpeg({quality:95}).toBuffer();
    const portrait=await sharp({create:{width:2400,height:1200,channels:3,background:'red'}}).withMetadata({orientation:6}).jpeg().toBuffer();
    const small=await sharp({create:{width:8,height:6,channels:3,background:'green'}}).png().toBuffer();
    const frames=Buffer.alloc(64*128*4);
    for(let index=0;index<64*128;index++){frames[index*4+(index<64*64?0:2)]=255;frames[index*4+3]=255;}
    const gif=await sharp(frames,{raw:{width:64,height:128,channels:4,pageHeight:64}}).gif({delay:[100,100],loop:0}).toBuffer();
    assert.equal((await sharp(gif,{animated:true}).metadata()).pages,2);
    const sources=new Map([['photos/landscape.jpg',landscape],['photos/portrait.jpg',portrait],['photos/small.png',small],['photos/animated.gif',gif]]);
    const reads=new Map();
    let active=0,maximumActive=0,hold;
    globalThis.fetch=async(input,options)=>{
      const url=new URL(input);
      assert.equal(url.protocol,'https:');assert.equal(url.hostname,'test-1250000000.cos.ap-chengdu.myqcloud.com');
      assert.equal(options.redirect,'error');
      assert.ok(!url.searchParams.has('imageMogr2'));
      const key=decodeURIComponent(url.pathname.slice(1));
      reads.set(key,(reads.get(key)??0)+1);
      active++;maximumActive=Math.max(maximumActive,active);
      try{if(hold)await hold;else await new Promise(ready=>setTimeout(ready,5));}
      finally{active--;}
      if(key==='photos/oversized.jpg'){
        let chunks=0;
        return new Response(new ReadableStream({pull(controller){if(chunks++<65)controller.enqueue(Buffer.alloc(1024**2));else controller.close();}}));
      }
      return new Response(sources.get(key)??landscape,{headers:{'Content-Type':'image/jpeg'}});
    };
    const {previewResponse}=await import('../preview.mjs?unit='+randomUUID());
    const duplicates=await Promise.all(Array.from({length:19},()=>previewResponse('photos/landscape.jpg')));
    assert.ok(duplicates.every(response=>response.status===200));
    assert.equal(reads.get('photos/landscape.jpg'),1);
    const preview=Buffer.from(await duplicates[0].arrayBuffer());
    const metadata=await sharp(preview).metadata();
    assert.equal(metadata.format,'webp');assert.equal(metadata.width,1280);assert.equal(metadata.height,800);
    assert.ok(preview.length<landscape.length/2,'The preview transfers less than half the original bytes');
    assert.equal(duplicates[0].headers.get('content-disposition'),'inline');
    const additional=resolve(cache,'4'.repeat(64)+'.webp');
    await writeFile(additional,'');await truncate(additional,60*1024**2);
    const rotated=await sharp(Buffer.from(await (await previewResponse('photos/portrait.jpg')).arrayBuffer())).metadata();
    assert.equal(rotated.width,640);assert.equal(rotated.height,1280);assert.equal(rotated.orientation,undefined);
    await assert.rejects(stat(resolve(cache,'2'.repeat(64)+'.webp')),{code:'ENOENT'},'New generations evict old cache files to keep the byte limit');
    const tiny=await sharp(Buffer.from(await (await previewResponse('photos/small.png')).arrayBuffer())).metadata();
    assert.equal(tiny.width,8);assert.equal(tiny.height,6);
    const staticGif=Buffer.from(await (await previewResponse('photos/animated.gif')).arrayBuffer());
    const gifPreview=await sharp(staticGif).metadata();
    assert.ok(!gifPreview.pages||gifPreview.pages===1);assert.equal(gifPreview.height,64);
    const colour=await sharp(staticGif).raw().toBuffer();
    assert.ok(colour[0]>200&&colour[2]<50,'Only the first GIF frame is used');
    const cold=await Promise.all(Array.from({length:19},(_,index)=>previewResponse(`photos/cold-${index}.jpg`)));
    assert.ok(cold.every(response=>response.status===200));assert.equal(maximumActive,1);
    let release;
    hold=new Promise(ready=>{release=ready;});
    let rejected=0;
    const overloaded=Array.from({length:40},(_,index)=>previewResponse(`photos/queued-${index}.jpg`).then(response=>{if(response.status===503)rejected++;return response;}));
    const deadline=Date.now()+3000;
    while(rejected<8&&Date.now()<deadline)await new Promise(ready=>setTimeout(ready,10));
    release();hold=undefined;
    const responses=await Promise.all(overloaded);
    assert.equal(responses.filter(response=>response.status===503).length,8);
    assert.equal(responses.filter(response=>response.status===200).length,32);
    assert.equal(maximumActive,1);
    sources.set('photos/invalid.jpg',Buffer.from('invalid image'));
    await assert.rejects(previewResponse('photos/invalid.jpg'));
    sources.set('photos/invalid.jpg',small);
    assert.equal((await previewResponse('photos/invalid.jpg')).status,200,'A failed job must not poison the queue');
    const hugePixels=Buffer.from(landscape);
    const frame=hugePixels.indexOf(Buffer.from([255,192]));
    assert.ok(frame>0);hugePixels.writeUInt16BE(11000,frame+5);hugePixels.writeUInt16BE(11000,frame+7);
    sources.set('photos/huge-pixels.jpg',hugePixels);
    await assert.rejects(previewResponse('photos/huge-pixels.jpg'),/pixel limit/);
    await assert.rejects(previewResponse('photos/oversized.jpg'),/64 MiB/);
    const files=await readdir(cache);
    assert.ok(files.every(name=>/^[a-f0-9]{64}\.webp$/.test(name)));
    const total=(await Promise.all(files.map(name=>stat(resolve(cache,name))))).reduce((sum,item)=>sum+item.size,0);
    assert.ok(total<=128*1024**2);
    const readsBefore=reads.get('photos/landscape.jpg');
    const restarted=await import('../preview.mjs?restart='+randomUUID());
    assert.deepEqual(Buffer.from(await (await restarted.previewResponse('photos/landscape.jpg')).arrayBuffer()),preview);
    assert.equal(reads.get('photos/landscape.jpg'),readsBefore,'Disk cache survives module restart');
  }finally{
    globalThis.fetch=originalFetch;
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];
    Object.assign(process.env,previous);
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-preview-unit-'));
    await rm(data,{recursive:true,force:true});
  }
});

test('Preview routes retain account checks while downloads and original routes keep exact original bytes',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-preview-routes-'));
  const origin='http://127.0.0.1:18096';
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18096',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only',COS_SECRET_KEY:'test-only'};
  const password=randomUUID();
  const original=await sharp({create:{width:1400,height:2100,channels:3,background:'purple'}}).jpeg().toBuffer();
  let server,gallery,catalog;
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));assert.equal((await once(setup,'exit'))[0],0);
    gallery=new DatabaseSync(resolve(data,'gallery.sqlite'));
    gallery.prepare("INSERT INTO photos(id,series,title,alt,src,image_key,photographer,is_sample,sort_order,created_at) VALUES ('preview-photo','scene','Preview','Preview','/api/media/preview-photo','photos/preview.jpg','Owner',0,0,?)").run(new Date().toISOString());
    gallery.prepare('INSERT INTO object_sizes VALUES (?,?)').run('preview-photo',original.length);
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));
    catalog.prepare('UPDATE users SET avatar_key=?,cover_key=?,directory_cover_key=? WHERE id=1').run('photos/avatar.jpg','photos/cover.jpg','photos/directory.jpg');
    const originalPath=resolve(data,'original.jpg');await writeFile(originalPath,original);
    const replacement=await sharp({create:{width:800,height:800,channels:3,background:'blue'}}).jpeg().toBuffer();
    const replacementPath=resolve(data,'replacement.jpg');await writeFile(replacementPath,replacement);
    const stub=resolve(data,'preview-cos-stub.mjs');
    await writeFile(stub,`import {readFile} from 'node:fs/promises';
const bytes=await readFile(${JSON.stringify(originalPath)});
const replacement=await readFile(${JSON.stringify(replacementPath)});
globalThis.fetch=async(input,options)=>{const url=new URL(input);if(url.hostname!=='test-1250000000.cos.ap-chengdu.myqcloud.com'||options.redirect!=='error')throw new Error('Unexpected upstream');return new Response(url.pathname==='/photos/new-cover.jpg'?replacement:bytes,{headers:{'Content-Type':'image/jpeg'}});};`);
    server=spawn(process.execPath,['--import',pathToFileURL(stub).href,'app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Preview server exited: ${code}`)));});
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
    for(const path of ['/api/media/yangyu/preview-photo','/api/media/preview-photo','/api/avatars/yangyu','/api/covers/yangyu','/api/directory-covers/yangyu']){
      const small=await request(path+'?preview=1');assert.equal(small.status,200);assert.equal(small.headers.get('location'),null);
      const metadata=await sharp(Buffer.from(await small.arrayBuffer())).metadata();
      assert.equal(metadata.format,'webp');assert.equal(metadata.width,853);assert.equal(metadata.height,1280);
      assert.deepEqual(Buffer.from(await (await request(path)).arrayBuffer()),original);
    }
    catalog.prepare('UPDATE users SET cover_key=? WHERE id=1').run('photos/new-cover.jpg');
    const changed=await sharp(Buffer.from(await (await request('/api/covers/yangyu?preview=1')).arrayBuffer())).metadata();
    assert.equal(changed.width,800);assert.equal(changed.height,800,'Replacing a profile key must not reuse its old preview');
    const legacyData=await (await request('/api/photos')).json();
    assert.equal(legacyData.photos[0].thumbnailSrc,'/api/media/preview-photo?preview=1');
    const login=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'admin',password})});
    const headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
    const managed=(await (await request('/api/admin/photos',{headers})).json()).photos[0];
    assert.equal(managed.src,'/api/media/yangyu/preview-photo');assert.equal(managed.thumbnailSrc,managed.src+'?preview=1');
    assert.equal((await request('/api/admin/download?id=preview-photo&preview=1')).status,401);
    for(const path of ['/api/admin/download?id=preview-photo&preview=1','/api/admin/export-image?id=preview-photo&preview=1'])assert.deepEqual(Buffer.from(await (await request(path,{headers})).arrayBuffer()),original);
    const invitation=await (await request('/api/platform/invitations',{method:'POST',headers,body:JSON.stringify({count:1,days:7,quotaBytes:10000,note:'Preview isolation'})})).json();
    const registered=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'other-user',displayName:'Other',password,passwordConfirmation:password,invitation:invitation.codes[0]})});
    assert.equal(registered.status,303);
    const otherHeaders={Cookie:registered.headers.get('set-cookie').split(';')[0]};
    assert.equal((await request('/api/media/other-user/preview-photo?preview=1')).status,404,'A warm cache cannot bypass the owning gallery lookup');
    assert.equal((await request('/api/admin/download?id=preview-photo&preview=1',{headers:otherHeaders})).status,404);
    const profile=await request('/api/profile',{method:'PATCH',headers,body:JSON.stringify({displayName:'Owner',publicId:'new-owner',bio:'',listed:true})});assert.equal(profile.status,200);
    assert.equal((await request('/api/media/yangyu/preview-photo?preview=1')).status,200);
    assert.equal((await request('/api/media/new-owner/preview-photo?preview=1')).status,200);
    assert.equal((await request('/api/media/no-owner/preview-photo?preview=1')).status,404);
    gallery.prepare('DELETE FROM photos WHERE id=?').run('preview-photo');
    assert.equal((await request('/api/media/yangyu/preview-photo?preview=1')).status,404,'Deleted records cannot be read through cached previews');
    catalog.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    for(const prefix of ['avatars','covers','directory-covers'])assert.equal((await request('/api/'+prefix+'/yangyu?preview=1')).status,404);
  }finally{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    gallery?.close();catalog?.close();
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-preview-routes-'));
    await rm(data,{recursive:true,force:true});
  }
});

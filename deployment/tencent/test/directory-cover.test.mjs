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

test('Directory cards use an isolated optional background and preserve profile text and quotas',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-directory-cover-test-'));
  const origin='http://127.0.0.1:18093';
  const password=randomBytes(18).toString('base64url');
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18093',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  let server,catalog;
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));
    assert.equal((await once(setup,'exit'))[0],0);
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));
    catalog.prepare('UPDATE users SET cover_key=?,cover_size=100,avatar_key=?,avatar_size=20 WHERE id=1').run('photos/covers/default.webp','photos/avatars/owner.webp');
    catalog.exec("ALTER TABLE users DROP COLUMN directory_cover_key; ALTER TABLE users DROP COLUMN directory_cover_size; ALTER TABLE users DROP COLUMN show_photo_names; DELETE FROM platform_migrations WHERE name='directory-cover'");
    const stub=resolve(data,'cos-profile-image-stub.mjs');
    // Keep actual URL signing and isolate the spawned server's COS reads and writes.
    await writeFile(stub,`import COS from ${JSON.stringify(pathToFileURL(resolve(directory,'node_modules/cos-nodejs-sdk-v5/index.js')).href)};
const objects=new Map();
COS.prototype.multipartInit=async()=>({UploadId:'test-upload'});
COS.prototype.multipartUpload=async({Key,Body})=>{objects.set('/'+Key,Buffer.from(Body));return {ETag:'test-etag'};};
COS.prototype.multipartComplete=async()=>({});
COS.prototype.multipartAbort=async()=>({});
COS.prototype.deleteObject=async({Key})=>{objects.delete('/'+Key);return {};};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.hostname==='test-1250000000.cos.ap-chengdu.myqcloud.com')return objects.has(url.pathname)?new Response(objects.get(url.pathname),{headers:{'Content-Type':'image/webp'}}):new Response('Missing',{status:404});
 if(url.hostname.endsWith('.myqcloud.com'))throw new Error('Unexpected COS test request');
 return originalFetch(input,options);
};`);
    server=spawn(process.execPath,['--import',pathToFileURL(stub).href,'app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server failed: ${code}`)));});
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
    assert.equal((await request('/api/profile/directory-cover')).status,401);
    const login=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'admin',password})});
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    const imageHeaders={Cookie:cookie,Origin:origin,'Content-Type':'image/webp'};
    const invitation=await (await request('/api/platform/invitations',{method:'POST',headers,body:JSON.stringify({count:1,days:7,quotaBytes:10000,note:'Directory background isolation'})})).json();
    const registered=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'other-user',displayName:'Other',password,passwordConfirmation:password,invitation:invitation.codes[0]})});
    assert.equal(registered.status,303);
    const otherCookie=registered.headers.get('set-cookie').split(';')[0];
    const otherHeaders={Cookie:otherCookie,Origin:origin,'Content-Type':'application/json'};
    const otherAccount=(await (await request('/api/session',{headers:otherHeaders})).json()).account;
    assert.equal(otherAccount.directoryCoverUrl,'');
    assert.equal((await request('/api/directory-covers/yangyu')).status,404);
    assert.equal((await request('/api/directory-covers/other-user')).status,404);
    const fields={displayName:'Owner <script> & "name"',bio:'Signature <script> & "signature"',region:'Region <script> & "region"',introduction:'Introduction <script> & "introduction"',listed:true};
    assert.equal((await request('/api/profile',{method:'PATCH',headers,body:JSON.stringify(fields)})).status,200);
    const cards=html=>[...html.matchAll(/<a\b[^>]*class="[^"]*\bphotographer-card\b[^>]*>[\s\S]*?<\/a>/g)].map(match=>match[0]);
    const initialCards=cards(await (await request('/')).text());
    const ownerCard=initialCards.find(card=>card.includes('href="/yangyu"'));
    assert.ok(ownerCard.includes('has-cover'));assert.ok(ownerCard.includes('class="directory-cover"'));
    assert.ok(ownerCard.includes('src="/api/covers/yangyu"'));assert.ok(ownerCard.includes('src="/api/avatars/yangyu"'));
    assert.ok(ownerCard.includes('Owner &lt;script&gt; &amp; &quot;name&quot;'));
    for(const [className,text] of [['card-signature','Signature'],['card-region','Region'],['card-introduction','Introduction']]){
      assert.ok(ownerCard.includes(`class="${className}"`));
      assert.ok(ownerCard.includes(`${text} &lt;script&gt; &amp; &quot;${text.toLowerCase()}&quot;`));
    }
    assert.ok(!ownerCard.includes('<script>'));
    const emptyCard=initialCards.find(card=>card.includes('href="/other-user"'));
    for(const absent of ['has-cover','directory-cover','directory-avatar','card-signature','card-region','card-introduction']) assert.ok(!emptyCard.includes(absent),absent);
    const initialProfile=await (await request('/api/profile',{headers})).json();
    assert.equal(initialProfile.account.directoryCoverUrl,'');assert.equal(initialProfile.usage.storageBytes,120);
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:{...imageHeaders,'Content-Type':'image/png'},body:'not an image'})).status,400);
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:imageHeaders,body:Buffer.alloc(4*1024**2+1)})).status,413);
    const image=Buffer.alloc(64);image.write('RIFF',0);image.write('WEBP',8);
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:{...imageHeaders,Origin:'https://attacker.test'},body:image})).status,403);
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:imageHeaders,body:image})).status,200);
    const saved=catalog.prepare('SELECT cover_key,directory_cover_key,directory_cover_size FROM users WHERE id=1').get();
    assert.equal(saved.cover_key,'photos/covers/default.webp');assert.ok(saved.directory_cover_key);assert.equal(saved.directory_cover_size,image.length);
    const uploadedProfile=await (await request('/api/profile',{headers})).json();
    assert.equal(uploadedProfile.account.directoryCoverUrl,'/api/directory-covers/yangyu');assert.equal(uploadedProfile.usage.storageBytes,184);
    assert.equal((await (await request('/api/profile',{headers:otherHeaders})).json()).usage.storageBytes,0);
    const independentCard=cards(await (await request('/')).text()).find(card=>card.includes('href="/yangyu"'));
    assert.ok(independentCard.includes('src="/api/directory-covers/yangyu"'));assert.ok(!independentCard.includes('src="/api/covers/yangyu"'));
    const publicCover=await request('/api/directory-covers/yangyu');
    assert.equal(publicCover.status,200);assert.equal(publicCover.headers.get('location'),null);
    assert.equal(publicCover.headers.get('content-disposition'),'inline');assert.deepEqual(Buffer.from(await publicCover.arrayBuffer()),image);
    assert.equal((await request('/api/directory-covers/other-user')).status,404);
    assert.equal((await request('/api/profile/directory-cover',{method:'DELETE',headers:otherHeaders})).status,200);
    assert.equal(catalog.prepare('SELECT directory_cover_key FROM users WHERE id=1').get().directory_cover_key,saved.directory_cover_key);
    const maximumImage=Buffer.alloc(4*1024**2);maximumImage.write('RIFF',0);maximumImage.write('WEBP',8);
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:imageHeaders,body:maximumImage})).status,200);
    assert.equal((await (await request('/api/profile',{headers})).json()).usage.storageBytes,120+maximumImage.length);
    assert.equal((await request('/api/profile',{method:'PATCH',headers,body:JSON.stringify({...fields,publicId:'owner-renamed'})})).status,200);
    for(const id of ['yangyu','owner-renamed']){
      const response=await request('/api/directory-covers/'+id);
      assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),maximumImage);
    }
    assert.equal((await request('/api/profile/directory-cover',{method:'DELETE',headers})).status,200);
    const removed=await (await request('/api/profile',{headers})).json();
    assert.equal(removed.account.directoryCoverUrl,'');assert.equal(removed.usage.storageBytes,120);
    assert.equal((await request('/api/directory-covers/yangyu')).status,404);
    const restoredCard=cards(await (await request('/')).text()).find(card=>card.includes('href="/owner-renamed"'));
    assert.ok(restoredCard.includes('src="/api/covers/owner-renamed"'));assert.ok(!restoredCard.includes('src="/api/directory-covers/'));
    catalog.prepare('UPDATE users SET quota_bytes=120 WHERE id=1').run();
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:imageHeaders,body:image})).status,413);
    assert.equal(catalog.prepare('SELECT directory_cover_size FROM users WHERE id=1').get().directory_cover_size,0);
    catalog.prepare('UPDATE users SET quota_bytes=5000000 WHERE id=1').run();
    assert.equal((await request('/api/profile/directory-cover',{method:'POST',headers:{Cookie:otherCookie,Origin:origin,'Content-Type':'image/webp'},body:image})).status,200);
    const otherSaved=catalog.prepare('SELECT directory_cover_key FROM users WHERE id=?').get(otherAccount.id).directory_cover_key;
    assert.ok(otherSaved);assert.equal(catalog.prepare('SELECT directory_cover_key FROM users WHERE id=1').get().directory_cover_key,null);
    assert.equal((await request('/api/platform/accounts',{method:'PATCH',headers,body:JSON.stringify({id:otherAccount.id,action:'disable'})})).status,200);
    assert.equal((await request('/api/directory-covers/other-user')).status,404);
    assert.ok(!cards(await (await request('/')).text()).some(card=>card.includes('href="/other-user"')));
    assert.equal((await request('/api/platform/accounts',{method:'PATCH',headers,body:JSON.stringify({id:otherAccount.id,action:'enable'})})).status,200);
    assert.equal((await request('/api/directory-covers/other-user')).status,200);
  }finally{
    catalog?.close();
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-directory-cover-test-'));
    await rm(data,{recursive:true,force:true});
  }
});

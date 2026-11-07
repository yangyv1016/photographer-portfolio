import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Same-origin multipart uploads enforce ownership, CSRF, exact sizes and quota before current-bucket writes',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-upload-proxy-test-'));
  const origin='http://127.0.0.1:18094';
  const password=randomBytes(18).toString('base64url');
  const bucket='new-lhcos-1250000000';
  const region='ap-chengdu';
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18094',COS_BUCKET:bucket,COS_REGION:region,COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  const partSize=8*1024**2;
  const callsPath=resolve(data,'cos-part-calls.json');
  let server,catalog,gallery;
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));
    assert.equal((await once(setup,'exit'))[0],0);
    await writeFile(callsPath,'[]');
    const stub=resolve(data,'cos-parts-stub.mjs');
    await writeFile(stub,`import COS from ${JSON.stringify(pathToFileURL(resolve(directory,'node_modules/cos-nodejs-sdk-v5/index.js')).href)};
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const callsPath=${JSON.stringify(callsPath)};
COS.prototype.multipartInit=async()=>({UploadId:'registered-cos-task'});
COS.prototype.multipartUpload=async({Bucket,Region,Key,UploadId,PartNumber,Body})=>{
 const calls=JSON.parse(await readFile(callsPath,'utf8'));
 calls.push({Bucket,Region,Key,UploadId,PartNumber,size:Body.length,hash:createHash('sha256').update(Body).digest('hex')});
 await writeFile(callsPath,JSON.stringify(calls));
 if(Body[0]===238)throw new Error('Upstream unavailable');
 if(Body[0]===239)return {};
 return {ETag:'"part-'+PartNumber+'"'};
};
COS.prototype.headObject=async()=>{throw new Error('Unexpected COS head');};
globalThis.fetch=async()=>{throw new Error('Unexpected network request in COS stub');};`);
    server=spawn(process.execPath,['--import',pathToFileURL(stub).href,'app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server failed: ${code}`)));});
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
    const login=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'admin',password})});
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    const partHeaders={Cookie:cookie,Origin:origin,'Content-Type':'application/octet-stream'};
    const created=await request('/api/admin/uploads',{method:'POST',headers,body:JSON.stringify({series:'scene',title:'Proxy original',contentType:'image/jpeg',size:partSize+3})});
    assert.equal(created.status,201);
    const task=await created.json();assert.equal(task.partSize,partSize);
    gallery=new DatabaseSync(resolve(data,'gallery.sqlite'));
    catalog=new DatabaseSync(resolve(data,'platform.sqlite'));
    const stored=gallery.prepare('SELECT image_key,upload_id,size FROM photo_uploads WHERE id=?').get(task.id);
    assert.equal(stored.upload_id,'registered-cos-task');assert.equal(stored.size,partSize+3);
    const endpoint=`/api/admin/upload-part?id=${task.id}&part=`;
    const finalPart=Buffer.from([42,43,44]);
    assert.equal((await request(endpoint+'2',{method:'PUT',headers:{Origin:origin},body:finalPart})).status,401);
    assert.equal((await request(endpoint+'2',{method:'PUT',headers:{...partHeaders,Origin:'https://attacker.test'},body:finalPart})).status,403);
    assert.equal((await request(endpoint+'2',{method:'PUT',headers:{Cookie:cookie},body:finalPart})).status,403);
    for(const part of ['0','-1','1.5','3','10001','invalid'])assert.equal((await request(endpoint+part,{method:'PUT',headers:partHeaders,body:finalPart})).status,400,part);
    assert.equal((await request(`/api/admin/upload-part?id=${randomUUID()}&part=1`,{method:'PUT',headers:partHeaders,body:finalPart})).status,404);
    assert.equal((await request('/api/admin/upload-part?id=invalid&part=1',{method:'PUT',headers:partHeaders,body:finalPart})).status,400);
    for(const body of [Buffer.alloc(0),Buffer.alloc(2),Buffer.alloc(4)])assert.equal((await request(endpoint+'2',{method:'PUT',headers:partHeaders,body})).status,400);
    assert.equal((await request(endpoint+'1',{method:'PUT',headers:partHeaders,body:Buffer.alloc(partSize+1)})).status,413);
    assert.equal((await request(endpoint+'1',{method:'POST',headers:partHeaders,body:Buffer.alloc(1024**2+1)})).status,413);
    assert.equal((await request('/api/admin/photos',{method:'PATCH',headers,body:Buffer.alloc(1024**2+1)})).status,413);
    const invitation=await (await request('/api/platform/invitations',{method:'POST',headers,body:JSON.stringify({count:1,days:7,quotaBytes:10000,note:'Upload proxy isolation'})})).json();
    const registered=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'otheruser',displayName:'Other',password,passwordConfirmation:password,invitation:invitation.codes[0]})});
    assert.equal(registered.status,303);
    const otherCookie=registered.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(endpoint+'2',{method:'PUT',headers:{...partHeaders,Cookie:otherCookie},body:finalPart})).status,404);
    catalog.prepare('UPDATE users SET quota_bytes=? WHERE id=1').run(partSize+2);
    assert.equal((await request(endpoint+'2',{method:'PUT',headers:partHeaders,body:finalPart})).status,413);
    assert.equal((await request('/api/admin/uploads',{method:'POST',headers,body:JSON.stringify({series:'scene',title:'No room',contentType:'image/jpeg',size:1})})).status,413);
    assert.deepEqual(JSON.parse(await readFile(callsPath,'utf8')),[],'Rejected requests never reach COS');
    catalog.prepare('UPDATE users SET quota_bytes=? WHERE id=1').run(5*1024**3);
    const firstPart=Buffer.alloc(partSize,123);firstPart.set([255,216,255]);
    for(const [part,body] of [[1,firstPart],[2,finalPart]]){
      const response=await request(endpoint+part+'&key=photos/attacker.jpg&bucket=old-bucket&uploadId=wrong-task',{method:'PUT',headers:partHeaders,body});
      assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.deepEqual(await response.json(),{etag:`"part-${part}"`});
    }
    const calls=JSON.parse(await readFile(callsPath,'utf8'));
    assert.deepEqual(calls,[[1,firstPart],[2,finalPart]].map(([part,body])=>({Bucket:bucket,Region:region,Key:stored.image_key,UploadId:stored.upload_id,PartNumber:part,size:body.length,hash:createHash('sha256').update(body).digest('hex')})));
    for(const firstByte of [238,239])assert.equal((await request(endpoint+'2',{method:'PUT',headers:partHeaders,body:Buffer.from([firstByte,0,0])})).status,503);
    assert.equal(gallery.prepare('SELECT COUNT(*) AS count FROM photo_uploads WHERE id=?').get(task.id).count,1);
    assert.equal(gallery.prepare('SELECT COUNT(*) AS count FROM photos').get().count,0);
    assert.equal((await request('/api/session',{headers:{Cookie:otherCookie}})).status,200);

    const otherHeaders={...headers,Cookie:otherCookie};
    const additionalImage=Buffer.alloc(10001,123);additionalImage.set([255,216,255]);
    const startExpanded=()=>request('/api/admin/uploads',{
      method:'POST',headers:otherHeaders,
      body:JSON.stringify({series:'scene',title:'Expanded upload',contentType:'image/jpeg',size:additionalImage.length}),
    });
    assert.equal((await startExpanded()).status,413);
    const expansion=await request('/api/platform/invitations',{
      method:'POST',headers,body:JSON.stringify({count:1,days:7,addOnBytes:1,note:'Upload expansion'}),
    });
    assert.equal(expansion.status,201);
    const expansionCode=(await expansion.json()).codes[0];
    const redeemed=await request('/api/profile/subscription',{
      method:'POST',headers:otherHeaders,body:JSON.stringify({code:expansionCode}),
    });
    assert.equal(redeemed.status,200);
    const expandedUpload=await startExpanded();
    assert.equal(expandedUpload.status,201);
    const expandedTask=await expandedUpload.json();
    assert.equal((await request(`/api/admin/upload-part?id=${expandedTask.id}&part=1`,{
      method:'PUT',headers:{...partHeaders,Cookie:otherCookie},body:additionalImage,
    })).status,200);
    const expandedSession=await (await request('/api/session',{headers:otherHeaders})).json();
    assert.equal(expandedSession.account.quotaBytes,10000);assert.equal(expandedSession.account.storageAddonBytes,1);
    assert.equal(expandedSession.account.totalQuotaBytes,10001);
    assert.equal(expandedSession.usage.pendingBytes,10001);assert.equal(expandedSession.usage.availableBytes,0);
  }finally{
    gallery?.close();catalog?.close();
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-upload-proxy-test-'));
    await rm(data,{recursive:true,force:true});
  }
});

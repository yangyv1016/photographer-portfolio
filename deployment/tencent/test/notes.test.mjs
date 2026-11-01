import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Notes stay in each gallery, survive upgrades and publish escaped content without object storage',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-notes-test-'));
  const origin='http://127.0.0.1:18095';
  const password=randomBytes(18).toString('base64url');
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18095',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  const callsPath=resolve(data,'forbidden-cos-calls.txt');
  const stub=resolve(data,'notes-no-cos.mjs');
  let server;
  const databases=[];
  const startServer=async()=>{
    server=spawn(process.execPath,['--import',pathToFileURL(stub).href,'app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
    let errors='';
    server.stderr.on('data',chunk=>{errors+=chunk.toString();});
    await new Promise((ready,reject)=>{
      server.stdout.once('data',ready);
      server.once('error',reject);
      server.once('exit',code=>reject(new Error(`Notes server failed: ${code}; ${errors}`)));
    });
  };
  const stopServer=async()=>{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
  };
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'admin',password}));
    assert.equal((await once(setup,'exit'))[0],0);
    const legacy=new DatabaseSync(resolve(data,'gallery.sqlite'));databases.push(legacy);
    legacy.exec('DROP TABLE notes; CREATE TABLE notes (id TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
    const legacyNotes=[
      {id:randomUUID(),content:'Legacy first title  \nSecond line preserved',title:'Legacy first title'},
      {id:randomUUID(),content:'标题'.repeat(60)+'\r\n原正文保留',title:'标题'.repeat(40)},
      {id:randomUUID(),content:'Legacy third title\r\nThird body preserved',title:'Legacy third title'},
    ];
    const insertLegacy=legacy.prepare('INSERT INTO notes (id,content,created_at,updated_at) VALUES (?,?,?,?)');
    for(const [index,note] of legacyNotes.entries())insertLegacy.run(note.id,note.content,`202${index}-01-01T00:00:00.000Z`,`202${index}-01-01T00:00:00.000Z`);
    const legacyNotesBefore=legacy.prepare('SELECT id,content,created_at,updated_at FROM notes ORDER BY id').all();
    legacy.prepare("INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES ('legacy-photo','scene','Preserved photo','Preserved photo','/assets/scene-01.jpg','Owner',1,42,'2020-01-01T00:00:00.000Z')").run();
    const originalPhotos=legacy.prepare('SELECT * FROM photos ORDER BY id').all();
    const originalSeries=legacy.prepare('SELECT * FROM series ORDER BY id').all();
    await writeFile(callsPath,'');
    await writeFile(stub,`import COS from ${JSON.stringify(pathToFileURL(resolve(directory,'node_modules/cos-nodejs-sdk-v5/index.js')).href)};
import {appendFileSync} from 'node:fs';
const deny=name=>{appendFileSync(${JSON.stringify(callsPath)},name+'\\n');throw new Error('Notes must not access object storage');};
for(const name of ['headObject','getObject','getObjectUrl','multipartInit','multipartUpload','multipartComplete','multipartAbort','deleteObject','deleteMultipleObject'])COS.prototype[name]=()=>deny(name);
globalThis.fetch=async()=>deny('network');`);
    await startServer();
    const request=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
    const signIn=async username=>{
      const response=await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username,password})});
      assert.equal(response.status,303);
      return {Cookie:response.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
    };
    const adminHeaders=await signIn('admin');
    const notes=(headers,method='GET',body)=>request('/api/profile/notes',{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const migrated=(await (await notes(adminHeaders)).json()).notes;
    assert.equal(migrated.length,3);
    for(const note of legacyNotes){
      const saved=migrated.find(item=>item.id===note.id);
      assert.equal(saved.title,note.title);
      assert.equal(saved.content,note.content,'Title migration keeps the full original content');
    }
    assert.deepEqual(legacy.prepare('SELECT id,content,created_at,updated_at FROM notes ORDER BY id').all(),legacyNotesBefore);
    assert.equal((await notes(adminHeaders,'PATCH',{id:legacyNotes[1].id,title:'自定义旧标题',content:legacyNotes[1].content})).status,200);
    const ownerNote=await (await notes(adminHeaders,'POST',{title:'Owner title',content:'Owner note'})).json();
    assert.equal(ownerNote.note.title,'Owner title');
    assert.equal(ownerNote.note.content,'Owner note');
    const invitations=await request('/api/platform/invitations',{method:'POST',headers:adminHeaders,body:JSON.stringify({count:2,days:7,quotaBytes:5*1024**3,note:'Notes isolation'})});
    const {codes}=await invitations.json();
    for(const [index,username] of ['alicia','boris'].entries()){
      const registered=await request('/register',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({username,password,passwordConfirmation:password,displayName:username,invitation:codes[index]})});
      assert.equal(registered.status,303);
    }
    let headersA=await signIn('alicia');
    let headersB=await signIn('boris');
    const accountA=(await (await request('/api/session',{headers:headersA})).json()).account;
    const catalog=new DatabaseSync(resolve(data,'platform.sqlite'));databases.push(catalog);
    const storageA=catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(accountA.id).storage_id;
    const galleryA=new DatabaseSync(resolve(data,'photographers',storageA,'gallery.sqlite'));databases.push(galleryA);
    const identities=catalog.prepare('SELECT id,storage_id FROM users ORDER BY id').all();
    const usageBefore=(await (await request('/api/profile',{headers:headersA})).json()).usage;
    assert.equal((await request('/api/profile',{method:'PATCH',headers:headersA,body:JSON.stringify({displayName:accountA.displayName,publicId:'notes-alicia',bio:'',listed:true})})).status,200);
    let visibilityNote;
    for(let step=0;step<4;step++){
      const visible=step===1||step===3;
      if(visible){
        const added=await notes(headersA,'POST',{title:'Visibility note',content:'Only Alicia visibility content'});
        assert.equal(added.status,201);
        visibilityNote=(await added.json()).note;
      }else if(step===2){
        assert.equal((await notes(headersA,'DELETE',{id:visibilityNote.id})).status,200);
      }
      for(const path of ['/alicia','/notes-alicia','/boris']){
        const response=await request(path);
        assert.equal(response.status,200);
        const html=await response.text();
        const expectedVisible=path!=='/boris'&&visible;
        assert.equal(/\bid=["']notebook["']/.test(html),expectedVisible,`${path}: notebook visibility at step ${step}`);
        assert.equal(/\bhref=["']#notebook["']/.test(html),expectedVisible,`${path}: notebook navigation at step ${step}`);
        const publicData=JSON.parse(html.match(/<script id="gallery-data" type="application\/json">(.*?)<\/script>/s)[1]);
        assert.equal(publicData.notes.length,expectedVisible?1:0);
      }
      const workspaceHtml=await (await request('/dashboard/notes',{headers:headersA})).text();
      assert.ok(workspaceHtml.includes('href="/dashboard/notes"'),'The private notes entry remains available when public notes are empty');
    }
    assert.equal((await notes(headersA,'DELETE',{id:visibilityNote.id})).status,200);
    for(const method of ['GET','POST','PATCH','DELETE'])assert.equal((await notes({Origin:origin},method,method==='GET'?undefined:{id:randomUUID(),content:'Denied'})).status,401);
    for(const method of ['POST','PATCH','DELETE'])assert.equal((await notes({...headersA,Origin:'https://attacker.test'},method,{id:randomUUID(),content:'Denied'})).status,403);
    const unsupported=await notes(headersA,'PUT',{content:'Denied'});
    assert.equal(unsupported.status,405);
    assert.equal(unsupported.headers.get('allow'),'GET, POST, PATCH, DELETE');
    assert.equal((await request('/dashboard/notes')).status,303);
    const workspace=await request('/dashboard/notes',{headers:headersA});
    assert.equal(workspace.status,200);
    assert.ok((await workspace.text()).includes('data-page="notes"'));
    assert.equal((await request('/api/profile/notes',{method:'POST',headers:headersA,body:'{'})).status,400);
    for(const content of ['', ' \n\t ', 'x'.repeat(20001), 42, null])assert.equal((await notes(headersA,'POST',{title:'Valid title',content})).status,400);
    for(const title of ['', ' \n\t ', '题'.repeat(81), 42, null])assert.equal((await notes(headersA,'POST',{title,content:'Valid content'})).status,400);
    assert.equal((await notes(headersA,'POST',{})).status,400);
    assert.equal((await notes(headersA,'POST',{content:'Missing title'})).status,400);
    const payload='    <script id="note-xss">alert("x")</script>\n第二行 & <b>text</b>  \n';
    const created=await notes(headersA,'POST',{title:'  初始 <b>标题</b>  ',content:payload});
    assert.equal(created.status,201);
    const {note:first}=await created.json();
    assert.match(first.id,/^[a-f0-9-]{36}$/);
    assert.equal(first.title,'初始 <b>标题</b>');
    assert.equal(first.content,payload);
    assert.equal(first.updatedAt,first.createdAt);
    const secondResponse=await notes(headersA,'POST',{title:` ${'题'.repeat(80)} `,content:'字'.repeat(20000)});
    assert.equal(secondResponse.status,201);
    const {note:second}=await secondResponse.json();
    assert.equal(second.title.length,80);
    assert.equal(second.content.length,20000);
    assert.equal((await notes(headersA,'PATCH',{id:second.id,title:'题',content:second.content})).status,200);
    galleryA.prepare('UPDATE notes SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',first.id);
    galleryA.prepare('UPDATE notes SET created_at=? WHERE id=?').run('2021-01-01T00:00:00.000Z',second.id);
    assert.deepEqual((await (await notes(headersA)).json()).notes.map(note=>note.id),[second.id,first.id]);
    assert.deepEqual(await (await notes(headersB)).json(),{notes:[]});
    for(const method of ['PATCH','DELETE']){
      assert.equal((await notes(headersB,method,{id:first.id,title:'Foreign title',content:'Foreign change'})).status,404);
      assert.equal((await notes(headersA,method,{id:randomUUID(),title:'Missing title',content:'Missing'})).status,404);
      assert.equal((await notes(headersA,method,{id:'../not-a-uuid',title:'Invalid title',content:'Invalid'})).status,400);
    }
    const unchanged=(await (await notes(headersA)).json()).notes.find(note=>note.id===first.id);
    assert.equal(unchanged.title,first.title);
    assert.equal(unchanged.content,payload);
    assert.equal((await notes(headersA,'PATCH',{id:first.id,title:'Valid title',content:'  '})).status,400);
    assert.equal((await notes(headersA,'PATCH',{id:first.id,title:'Valid title',content:'x'.repeat(20001)})).status,400);
    assert.equal((await notes(headersA,'PATCH',{id:first.id,title:'题'.repeat(81),content:payload})).status,400);
    assert.equal((await notes(headersA,'PATCH',{id:first.id,content:payload})).status,400);
    const editedContent=' '+payload+'\n已编辑 ';
    const editedTitle='Edited <b>title</b>';
    assert.deepEqual(await (await notes(headersA,'PATCH',{id:first.id,title:` ${editedTitle} `,content:editedContent})).json(),{saved:true});
    const edited=(await (await notes(headersA)).json()).notes;
    assert.deepEqual(edited.map(note=>note.id),[second.id,first.id],'Editing does not reorder the original creation time');
    assert.equal(edited[1].createdAt,'2020-01-01T00:00:00.000Z');
    assert.equal(edited[1].title,editedTitle);
    assert.equal(edited[1].content,editedContent);
    assert.ok(Date.parse(edited[1].updatedAt)>Date.parse(edited[1].createdAt));
    const insert=galleryA.prepare('INSERT INTO notes (id,title,content,created_at,updated_at) VALUES (?,?,?,?,?)');
    for(let index=2;index<99;index++)insert.run(randomUUID(),`Title ${index}`,`Existing note ${index}`,'2019-01-01T00:00:00.000Z','2019-01-01T00:00:00.000Z');
    const atLimit=await Promise.all([notes(headersA,'POST',{title:'Limit A',content:'Limit A'}),notes(headersA,'POST',{title:'Limit B',content:'Limit B'})]);
    assert.deepEqual(atLimit.map(response=>response.status).sort(),[201,409]);
    assert.equal((await (await notes(headersA)).json()).notes.length,100);
    assert.equal((await notes(headersA,'PATCH',{id:first.id,title:editedTitle,content:editedContent})).status,200,'Existing notes remain editable at capacity');
    assert.deepEqual(await (await notes(headersA,'DELETE',{id:second.id})).json(),{deleted:true});
    assert.equal((await notes(headersA,'DELETE',{id:second.id})).status,404);
    assert.equal((await notes(headersA,'POST',{title:'Reused capacity',content:'Reused capacity'})).status,201);
    assert.equal((await notes(headersB,'POST',{title:'Only Boris',content:'Only Boris content'})).status,201,'The limit belongs to each gallery');
    const profile=await request('/api/profile',{method:'PATCH',headers:headersA,body:JSON.stringify({displayName:'Alicia',publicId:'notes-alicia',bio:'',listed:true})});
    assert.equal(profile.status,200);
    for(const path of ['/alicia','/notes-alicia']){
      const response=await request(path);
      assert.equal(response.status,200);
      const html=await response.text();
      assert.ok(html.includes('id="notebook"'));
      assert.ok(html.indexOf('id="notebook"')>html.indexOf('id="collections"'));
      assert.ok(html.includes('Edited &lt;b&gt;title&lt;/b&gt;'));
      assert.ok(!html.includes('<script id="note-xss">'));
      assert.ok(!html.includes('Edited <b>title</b>'));
      const publicData=JSON.parse(html.match(/<script id="gallery-data" type="application\/json">(.*?)<\/script>/s)[1]);
      const publicNote=publicData.notes.find(note=>note.id===first.id);
      assert.equal(publicNote.title,editedTitle);
      assert.equal(publicNote.content,editedContent);
      assert.ok(!html.includes('Only Boris'));
    }
    const borisPage=await (await request('/boris')).text();
    assert.ok(borisPage.includes('Only Boris'));
    assert.ok(!borisPage.includes('note-xss'));
    assert.equal((await request('/api/platform/accounts',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({id:accountA.id,action:'disable'})})).status,200);
    assert.equal((await notes(headersA)).status,401);
    assert.equal((await request('/alicia')).status,404);
    assert.equal((await request('/notes-alicia')).status,404);
    assert.equal((await request('/boris')).status,200);
    assert.equal((await request('/api/platform/accounts',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({id:accountA.id,action:'enable'})})).status,200);
    headersA=await signIn('alicia');
    const savedA=await (await notes(headersA)).json();
    const savedB=await (await notes(headersB)).json();
    assert.deepEqual((await (await request('/api/profile',{headers:headersA})).json()).usage,usageBefore);
    await stopServer();
    await startServer();
    headersA=await signIn('alicia');
    headersB=await signIn('boris');
    assert.deepEqual(await (await notes(headersA)).json(),savedA);
    assert.deepEqual(await (await notes(headersB)).json(),savedB);
    const ownerNotes=(await (await notes(await signIn('admin'))).json()).notes;
    assert.equal(ownerNotes[0].id,ownerNote.note.id);
    assert.equal(ownerNotes.find(note=>note.id===legacyNotes[1].id).title,'自定义旧标题','Restart must not overwrite a saved title');
    for(const note of legacyNotes)assert.equal(ownerNotes.find(item=>item.id===note.id).content,note.content);
    assert.deepEqual(catalog.prepare('SELECT id,storage_id FROM users ORDER BY id').all(),identities);
    assert.deepEqual(legacy.prepare('SELECT * FROM photos ORDER BY id').all(),originalPhotos);
    assert.deepEqual(legacy.prepare('SELECT * FROM series ORDER BY id').all(),originalSeries);
    assert.equal(galleryA.prepare('SELECT COUNT(*) AS count FROM photos').get().count,0);
    assert.equal(galleryA.prepare('SELECT COUNT(*) AS count FROM object_sizes').get().count,0);
    assert.equal(await readFile(callsPath,'utf8'),'');
  }finally{
    await stopServer();
    for(const database of databases)database.close();
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-notes-test-'));
    await rm(data,{recursive:true,force:true});
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Existing single-owner photos, password and sessions migrate without replacing gallery data',{timeout:30000},async()=>{
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const data=await mkdtemp(resolve(tmpdir(),'yangyu-migration-test-'));
  const origin='http://127.0.0.1:18090';
  const password=randomBytes(18).toString('base64url');
  const environment={...process.env,YANGYU_ROOT:directory,DATA_DIRECTORY:data,PUBLIC_ORIGIN:origin,PORT:'18090',COS_BUCKET:'test-1250000000',COS_REGION:'ap-chengdu',COS_SECRET_ID:'test-only-id',COS_SECRET_KEY:'test-only-key'};
  let server,legacy,platform;
  try{
    const setup=spawn(process.execPath,['app/setup-admin.mjs'],{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
    setup.stdin.end(JSON.stringify({username:'legacy-admin',password}));
    assert.equal((await once(setup,'exit'))[0],0);
    await unlink(resolve(data,'platform.sqlite'));
    legacy=new DatabaseSync(resolve(data,'gallery.sqlite'));
    legacy.exec('DROP TRIGGER remove_object_size; DROP TABLE object_sizes;');
    legacy.prepare("INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES ('legacy-photo','scene','Legacy preserved','Legacy preserved','/assets/scene-01.jpg','Owner',1,42,?)").run(new Date().toISOString());
    const token=randomBytes(32).toString('hex');
    const hash=createHash('sha256').update(token).digest('hex');
    legacy.prepare('INSERT INTO admin_sessions VALUES (?,?)').run(hash,Date.now()+3600000);
    for(let pass=0;pass<3;pass++){
      server=spawn(process.execPath,['app/server.mjs'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
      await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server failed: ${code}`)));});
      const response=await fetch(origin+'/api/admin/photos',{headers:{Cookie:`yangyu_admin=${token}`}});
      assert.equal(response.status,200);
      const gallery=await response.json();
      assert.equal(gallery.photos.length,1);assert.equal(gallery.photos[0].title,'Legacy preserved');assert.equal(gallery.photos[0].sortOrder,42);
      assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get().count,0);
      const login=await fetch(origin+'/login',{redirect:'manual',method:'POST',headers:{Origin:origin},body:new URLSearchParams({username:'legacy-admin',password})});
      assert.equal(login.status,303);
      assert.equal((await fetch(origin+'/yangyu')).status,200);
      const session=await (await fetch(origin+'/api/session',{headers:{Cookie:`yangyu_admin=${token}`}})).json();
      assert.equal(session.account.quotaBytes,(pass === 2 ? 2 : 5)*1024**3);
      assert.equal(session.account.coverUrl,'');
      assert.equal(session.account.siteName,'旸隅');
      assert.equal(session.account.loginId,'legacy-admin');
      assert.equal(session.account.bio,pass===0?'':'Existing signature');
      assert.equal(session.account.introduction,pass===2?'Saved introduction':'');
      assert.equal(session.account.region,pass===2?'Saved region':'');
      assert.equal(session.account.directoryCoverUrl,pass===2?'/api/directory-covers/yangyu':'');
      assert.equal(session.account.showPhotoNames,pass===2);
      server.kill();await once(server,'exit');
      if(pass<2){
        platform=new DatabaseSync(resolve(data,'platform.sqlite'));
        if(pass===0){
          platform.prepare('UPDATE users SET quota_bytes=0 WHERE id=1').run();
          platform.prepare("INSERT INTO invitations (id,token_hash,hint,quota_bytes,created_by,created_at) VALUES ('legacy-invite','legacy-hash','legacy',0,1,?)").run(new Date().toISOString());
          platform.prepare("DELETE FROM platform_migrations WHERE name='finite-storage-quotas'").run();
          platform.exec("ALTER TABLE users DROP COLUMN cover_key; ALTER TABLE users DROP COLUMN cover_size; DELETE FROM platform_migrations WHERE name='profile-cover'");
          platform.exec("ALTER TABLE users DROP COLUMN site_name; DROP TABLE public_id_aliases; DELETE FROM platform_migrations WHERE name='profile-site-and-aliases'");
          platform.exec("UPDATE users SET bio='Existing signature'; ALTER TABLE users DROP COLUMN introduction; ALTER TABLE users DROP COLUMN region; DELETE FROM platform_migrations WHERE name='profile-introduction'");
          platform.exec("ALTER TABLE users DROP COLUMN directory_cover_key; ALTER TABLE users DROP COLUMN directory_cover_size; ALTER TABLE users DROP COLUMN show_photo_names; DELETE FROM platform_migrations WHERE name='directory-cover'");
        }else{
          assert.equal(platform.prepare("SELECT quota_bytes FROM invitations WHERE id='legacy-invite'").get().quota_bytes,5*1024**3);
          platform.prepare('UPDATE users SET quota_bytes=? WHERE id=1').run(2*1024**3);
          platform.prepare('UPDATE users SET introduction=?,region=? WHERE id=1').run('Saved introduction','Saved region');
          assert.deepEqual({...platform.prepare('SELECT directory_cover_key,directory_cover_size,show_photo_names FROM users WHERE id=1').get()},{directory_cover_key:null,directory_cover_size:0,show_photo_names:0});
          platform.prepare('UPDATE users SET directory_cover_key=?,directory_cover_size=?,show_photo_names=1 WHERE id=1').run('photos/directory-covers/saved.webp',42);
        }
        platform.close();platform=undefined;
      }
    }
    platform=new DatabaseSync(resolve(data,'platform.sqlite'));
    assert.equal(platform.prepare('SELECT COUNT(*) AS count FROM users').get().count,1);
    assert.equal(platform.prepare('SELECT role FROM users WHERE id=1').get().role,'admin');
    assert.deepEqual({...platform.prepare('SELECT directory_cover_key,directory_cover_size,show_photo_names FROM users WHERE id=1').get()},{directory_cover_key:'photos/directory-covers/saved.webp',directory_cover_size:42,show_photo_names:1});
  }finally{
    legacy?.close();platform?.close();
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'exit');}
    assert.ok(data.startsWith(resolve(tmpdir())+sep+'yangyu-migration-test-'));
    await rm(data,{recursive:true,force:true});
  }
});

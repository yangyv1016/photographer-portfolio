import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

test('Expired subscriptions block public pages, old media links and uploads while owners retain their workspace and originals', { timeout: 45000 }, async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-subscription-boundaries-'));
  const origin = 'http://127.0.0.1:18132';
  const now = Date.parse('2026-11-07T04:00:00Z');
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18132',
    STORAGE_BACKEND: 'cos', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const original = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: 'purple' } }).jpeg().toBuffer();
  const originalPath = resolve(data, 'original.jpg');
  const callsPath = resolve(data, 'object-reads.txt');
  const stub = resolve(data, 'boundary-stub.mjs');
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  let server, catalog, gallery;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    const storageId = randomUUID();
    const otherStorageId = randomUUID();
    const insertAccount = catalog.prepare(`INSERT INTO users
      (login_id,public_id,storage_id,password_hash,display_name,site_name,role,quota_bytes,created_at,subscription_plan,subscription_expires_at)
      SELECT ?,?,?,password_hash,?,?,'photographer',?,created_at,?,? FROM users WHERE id=1`);
    const expiredId = Number(insertAccount.run('expired-user', 'expired-user', storageId, 'Expired photographer', 'Expired photographer', 5 * 1024 ** 3, 'monthly', now).lastInsertRowid);
    insertAccount.run('grandfather', 'grandfather', otherStorageId, 'Existing photographer', 'Existing photographer', 5 * 1024 ** 3, null, null);
    catalog.prepare('INSERT INTO public_id_aliases VALUES (?,?)').run('old-expired', expiredId);
    catalog.prepare('UPDATE users SET avatar_key=?,cover_key=?,directory_cover_key=?,avatar_size=?,cover_size=?,directory_cover_size=? WHERE id=?')
      .run('photos/expired.jpg', 'photos/expired.jpg', 'photos/expired.jpg', original.length, original.length, original.length, expiredId);
    // A legacy administrator remains exempt even when an expiry value is present.
    catalog.prepare('UPDATE users SET subscription_expires_at=? WHERE id=1').run(now);
    const galleryDirectory = resolve(data, 'photographers', storageId);
    for (const id of [storageId, otherStorageId]) {
      const folder = resolve(data, 'photographers', id);
      await mkdir(folder, { recursive: true });
      new DatabaseSync(resolve(folder, 'gallery.sqlite')).close();
    }
    await writeFile(originalPath, original);
    await writeFile(callsPath, '');
    await writeFile(stub, `import {readFile,appendFile} from 'node:fs/promises';
Date.now=()=>${now};
const bytes=await readFile(${JSON.stringify(originalPath)});
globalThis.fetch=async(input,options)=>{
 const url=new URL(input);
 if(url.hostname!=='test-1250000000.cos.ap-chengdu.myqcloud.com'||options.redirect!=='error')throw new Error('Unexpected object request');
 await appendFile(${JSON.stringify(callsPath)},url.pathname+'\\n');
 return new Response(bytes,{headers:{'Content-Type':'image/jpeg'}});
};`);
    server = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error('Boundary server failed (' + code + '): ' + errors)));
    });
    gallery = new DatabaseSync(resolve(galleryDirectory, 'gallery.sqlite'));
    gallery.prepare(`INSERT INTO photos (id,series,title,alt,src,image_key,photographer,is_sample,sort_order,created_at)
      VALUES ('subscription-photo','scene','Original photo','Original photo','/api/media/expired-user/subscription-photo','photos/expired.jpg','Expired photographer',0,0,?)`)
      .run(new Date(now).toISOString());
    gallery.prepare('INSERT INTO object_sizes VALUES (?,?)').run('subscription-photo', original.length);
    const pendingId = randomUUID();
    gallery.prepare('INSERT INTO photo_uploads (id,upload_id,image_key,series,title,content_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(pendingId, 'test-upload', 'photos/pending.jpg', 'scene', 'Pending', 'image/jpeg', original.length, new Date(now).toISOString());
    const login = async username => {
      const response = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username, password }) });
      assert.equal(response.status, 303);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const ownerCookie = await login('expired-user');
    const otherCookie = await login('grandfather');
    const adminCookie = await login('admin');
    const ownerHeaders = { Cookie: ownerCookie, Origin: origin, 'Content-Type': 'application/json' };
    const directoryHtml = await (await request('/')).text();
    assert.ok(!directoryHtml.includes('href="/expired-user"'));
    assert.ok(directoryHtml.includes('href="/grandfather"'));
    assert.ok(directoryHtml.includes('href="/yangyu"'));
    for (const path of ['/expired-user', '/expired-user/album', '/old-expired', '/old-expired/album']) {
      for (const headers of [{}, { Cookie: ownerCookie }]) {
        const response = await request(path, { headers });
        assert.equal(response.status, 403, path);
        assert.match(response.headers.get('cache-control'), /no-store/);
        assert.match(response.headers.get('x-robots-tag'), /noindex/);
        const html = await response.text();
        assert.ok(html.includes('本用户订阅已到期，请及时订阅'));
        assert.ok(!html.includes('gallery-data'));
      }
    }
    assert.equal((await request('/grandfather')).status, 200);
    assert.equal((await request('/yangyu')).status, 200);
    const mediaPaths = ['/api/media/expired-user/subscription-photo', '/api/media/old-expired/subscription-photo'];
    for (const publicId of ['expired-user', 'old-expired']) {
      for (const kind of ['avatars', 'covers', 'directory-covers']) mediaPaths.push('/api/' + kind + '/' + publicId);
    }
    for (const path of mediaPaths) {
      for (const suffix of ['', '?preview=1']) {
        for (const cookie of [null, otherCookie, adminCookie]) {
          const response = await request(path + suffix, { headers: cookie ? { Cookie: cookie } : {} });
          assert.equal(response.status, 403, path + suffix);
          assert.equal((await response.json()).error, '本用户订阅已到期，请及时订阅');
        }
      }
    }
    assert.equal(await readFile(callsPath, 'utf8'), '', 'Denied requests never reach original storage or preview generation');
    for (const path of ['/api/session', '/dashboard', '/dashboard/album', '/dashboard/subscription', '/api/admin/photos', '/api/profile/visits']) {
      assert.equal((await request(path, { headers: ownerHeaders })).status, 200, path);
    }
    const download = await request('/api/admin/download?id=subscription-photo', { headers: ownerHeaders });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    for (const path of mediaPaths) {
      assert.deepEqual(Buffer.from(await (await request(path, { headers: ownerHeaders })).arrayBuffer()), original, path);
    }
    const preview = await request(mediaPaths[0] + '?preview=1', { headers: ownerHeaders });
    assert.equal(preview.status, 200);
    assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, 'webp');
    const readsAfterOwner = await readFile(callsPath, 'utf8');
    assert.equal((await request(mediaPaths[0] + '?preview=1')).status, 403, 'A warm preview cache cannot bypass subscription expiry');
    for (const [path, options] of [
      ['/api/admin/uploads', { method: 'POST', body: JSON.stringify({ series: 'scene', title: 'Blocked', contentType: 'image/jpeg', size: original.length }) }],
      ['/api/admin/upload-part?id=' + pendingId + '&part=1', { method: 'PUT', body: original }],
      ['/api/admin/upload-part?id=' + pendingId + '&part=1', { method: 'GET' }],
      ['/api/admin/uploads', { method: 'PATCH', body: JSON.stringify({ id: pendingId, parts: [{ partNumber: 1, etag: 'test-etag' }] }) }],
      ['/api/profile/avatar', { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'image/jpeg' }, body: original }],
    ]) {
      assert.equal((await request(path, { headers: ownerHeaders, ...options })).status, 403, path);
    }
    const visits = catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count;
    const totals = catalog.prepare('SELECT COUNT(*) AS count FROM daily_visit_totals').get().count;
    for (const id of ['expired-user', 'old-expired']) {
      const response = await request('/api/visits/' + id, { method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': '198.51.100.11' } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count, visits);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visit_totals').get().count, totals);
    assert.equal(await readFile(callsPath, 'utf8'), readsAfterOwner);
    assert.equal(gallery.prepare('SELECT COUNT(*) AS count FROM photos').get().count, 1);
    assert.equal(gallery.prepare('SELECT COUNT(*) AS count FROM photo_uploads').get().count, 1);
    assert.equal(catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(expiredId).storage_id, storageId);
    assert.ok((await stat(resolve(galleryDirectory, 'gallery.sqlite'))).isFile());
    catalog.prepare('UPDATE users SET subscription_expires_at=? WHERE id=?').run(now + 86400000, expiredId);
    assert.equal((await request('/expired-user')).status, 200, 'Renewal restores public access without recreating the gallery');
    assert.equal((await request('/old-expired/album')).status, 200);
    assert.equal((await request(mediaPaths[0] + '?preview=1')).status, 200);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); }
    gallery?.close();
    catalog?.close();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-subscription-boundaries-'));
    await rm(data, { recursive: true, force: true });
  }
});

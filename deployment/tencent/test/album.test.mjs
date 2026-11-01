import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Albums preserve existing work order on upgrade and share owner-only series ordering with walls and covers', { timeout: 30000 }, async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-album-test-'));
  const origin = 'http://127.0.0.1:18100';
  const password = randomBytes(18).toString('base64url');
  const environment = { ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18100', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu', COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key' };
  const callsPath = resolve(data, 'forbidden-cos-calls.txt');
  const stub = resolve(data, 'album-no-cos.mjs');
  const databases = [];
  let server;
  const startServer = async () => {
    server = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk.toString(); });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Album server failed: ${code}; ${errors}`)));
    });
  };
  const stopServer = async () => {
    if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); }
  };
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    const owner = new DatabaseSync(resolve(data, 'gallery.sqlite')); databases.push(owner);
    owner.exec(`DROP TRIGGER append_photo_album_order; DROP INDEX idx_photos_album_order;
      ALTER TABLE photos DROP COLUMN album_order; ALTER TABLE photos DROP COLUMN show_on_wall;
      DELETE FROM server_migrations WHERE name='0003';`);
    const insertLegacy = owner.prepare('INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES (?,?,?,?,?,?,1,?,?)');
    for (const [id, series, order] of [['legacy-z', 'scene', 7], ['legacy-a', 'scene', 2], ['legacy-editorial', 'editorial', 6]]) {
      insertLegacy.run(id, series, id, id, '/assets/scene-01.jpg', 'Owner', order, '2020-01-01T00:00:00.000Z');
    }
    const originalPhotos = owner.prepare('SELECT * FROM photos ORDER BY id').all().map(photo => ({ ...photo }));
    const originalSeries = owner.prepare('SELECT * FROM series ORDER BY id').all();
    await writeFile(callsPath, '');
    await writeFile(stub, `import COS from ${JSON.stringify(pathToFileURL(resolve(directory, 'node_modules/cos-nodejs-sdk-v5/index.js')).href)};
import {appendFileSync} from 'node:fs';
const deny=name=>{appendFileSync(${JSON.stringify(callsPath)},name+'\\n');throw new Error('Album metadata must not access object storage');};
for(const name of ['headObject','getObject','getObjectUrl','multipartInit','multipartUpload','multipartComplete','multipartAbort','deleteObject','deleteMultipleObject'])COS.prototype[name]=()=>deny(name);
globalThis.fetch=async()=>deny('network');`);
    await startServer();
    const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
    const signIn = async username => {
      const response = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username, password }) });
      assert.equal(response.status, 303);
      return { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: origin, 'Content-Type': 'application/json' };
    };
    const adminHeaders = await signIn('admin');
    const gallery = async headers => (await (await request('/api/admin/photos', { headers })).json()).photos;
    const order = (headers, body) => request('/api/admin/album-order', { method: 'POST', headers, body: JSON.stringify(body) });
    const albumData = async (path, headers) => {
      const response = await request(path, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const html = await response.text();
      const data = JSON.parse(html.match(/<script id="album-data" type="application\/json">(.*?)<\/script>/s)[1]);
      const workspace = path.startsWith('/dashboard/album');
      assert.equal(data.canArrange, workspace, 'Only the authenticated workspace offers album editing');
      assert.equal(html.includes('id="album-arrange-controls"'), workspace, 'Public display pages never render ordering controls');
      for (const id of ['album-order-tools', 'album-move-position', 'reverse-album-order', 'reset-album-order']) {
        assert.equal(html.includes(`id="${id}"`), workspace, 'Additional ordering operations stay inside the private workspace');
      }
      assert.ok(html.includes('/album.js?v=20261102-series-order'));
      assert.ok(html.includes('/album.css?v=20261102-album-actions'));
      if (workspace) {
        assert.ok(html.includes('href="/dashboard"'));
        assert.ok(html.includes('href="/dashboard/album?series=scene"'));
        assert.ok(!html.includes('href="/dashboard/album"'), 'Workspace sorting has no all-series tab');
        assert.ok(data.selectedSeriesId, 'Workspace sorting always selects one series');
      } else {
        assert.ok(!html.includes(`href="/${data.publicId}/album"`), 'Public albums have no all-series tab either');
        assert.ok(data.selectedSeriesId, 'Public browsing always selects one series');
      }
      return data;
    };
    const migrated = await gallery(adminHeaders);
    assert.ok(migrated.every(photo => photo.showOnWall === true));
    assert.deepEqual([...migrated].sort((left, right) => left.albumOrder - right.albumOrder).map(photo => photo.id), ['legacy-a', 'legacy-z', 'legacy-editorial']);
    const migratedRows = owner.prepare('SELECT * FROM photos ORDER BY id').all();
    assert.deepEqual(migratedRows.map((photo, index) => Object.fromEntries(Object.keys(originalPhotos[index]).map(key => [key, photo[key]]))), originalPhotos);
    assert.deepEqual(owner.prepare('SELECT * FROM series ORDER BY id').all(), originalSeries);
    owner.exec("UPDATE photos SET album_order=CASE id WHEN 'legacy-z' THEN 0 WHEN 'legacy-a' THEN 1 ELSE 2 END");
    const legacyAlbumOrder = owner.prepare('SELECT id,album_order FROM photos ORDER BY id').all();
    await stopServer();
    await startServer();
    assert.deepEqual(owner.prepare('SELECT id,sort_order FROM photos ORDER BY id').all().map(photo => ({ ...photo })), originalPhotos.map(photo => ({ id: photo.id, sort_order: photo.sort_order })), 'An existing independent album order never replaces the saved work order on upgrade');
    const edit = { id: 'legacy-a', title: 'Hidden from wall', alt: 'Original description', series: 'scene' };
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ ...edit, showOnWall: false }) })).status, 200);
    assert.equal((await gallery(adminHeaders)).find(photo => photo.id === edit.id).showOnWall, false);
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify(edit) })).status, 200);
    assert.equal((await gallery(adminHeaders)).find(photo => photo.id === edit.id).showOnWall, false, 'Legacy edit requests preserve a hidden wall setting');
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ ...edit, showOnWall: 'false' }) })).status, 400);
    const page = await (await request('/yangyu')).text();
    const publicGallery = JSON.parse(page.match(/<script id="gallery-data" type="application\/json">(.*?)<\/script>/s)[1]);
    assert.equal(publicGallery.photos.length, 3);
    assert.equal(publicGallery.photos.find(photo => photo.id === edit.id).showOnWall, false, 'Hiding from the wall does not remove a public album photo');
    const publicAlbum = await albumData('/yangyu/album');
    assert.equal(publicAlbum.canArrange, false);
    assert.equal(publicAlbum.selectedSeriesId, publicAlbum.series[0].id, 'Public albums also default to the first series');
    assert.equal((await albumData('/yangyu/album', adminHeaders)).canArrange, false, 'The public album stays read-only even for its owner');
    assert.equal((await albumData('/yangyu/album?workspace=true&canArrange=true', adminHeaders)).canArrange, false);
    const anonymousWorkspace = await request('/dashboard/album');
    assert.equal(anonymousWorkspace.status, 303);
    assert.equal(anonymousWorkspace.headers.get('location'), '/login');
    const ownerWorkspace = await albumData('/dashboard/album', adminHeaders);
    assert.equal(ownerWorkspace.canArrange, true);
    assert.equal(ownerWorkspace.publicId, 'yangyu');
    assert.equal(ownerWorkspace.photos.length, 3);
    assert.equal(ownerWorkspace.selectedSeriesId, ownerWorkspace.series[0].id, 'The first series is selected by default');
    assert.equal((await albumData('/dashboard/album?series=scene', adminHeaders)).selectedSeriesId, 'scene');
    assert.equal((await request('/dashboard/album?series=missing', { headers: adminHeaders })).status, 404);
    assert.equal((await albumData('/yangyu/album?series=scene')).photos.length, 3, 'The album receives the full gallery for filter changes');
    assert.equal((await request('/yangyu/album?series=missing')).status, 404);
    assert.equal((await request('/nobody/album')).status, 404);
    assert.equal((await request('/api/admin/album-order', { method: 'GET', headers: adminHeaders })).status, 405);
    assert.equal((await order({ Origin: origin }, { ids: [] })).status, 401);
    assert.equal((await order({ ...adminHeaders, Origin: 'https://attacker.test' }, { ids: [] })).status, 403);
    assert.equal((await request('/api/admin/album-order', { method: 'POST', headers: adminHeaders, body: '{' })).status, 400);
    for (const body of [{ series: 'scene', ids: ['legacy-a', 'legacy-a'] }, { series: 'scene', ids: 'invalid' }, { ids: [], series: '' }, { ids: ['legacy-a', 'legacy-z'] }]) assert.equal((await order(adminHeaders, body)).status, 400);
    assert.equal((await order(adminHeaders, { series: 'missing', ids: [] })).status, 400);
    assert.equal((await order(adminHeaders, { series: 'scene', ids: ['legacy-a'] })).status, 409);
    assert.equal((await order(adminHeaders, { series: 'scene', ids: ['legacy-a', 'legacy-editorial'] })).status, 409);
    const editorialOrderBefore = owner.prepare("SELECT id,sort_order FROM photos WHERE series='editorial' ORDER BY id").all();
    assert.deepEqual(await (await order(adminHeaders, { series: 'scene', ids: ['legacy-z', 'legacy-a'] })).json(), { saved: true });
    assert.deepEqual(owner.prepare("SELECT id,sort_order FROM photos WHERE series='scene' ORDER BY sort_order").all().map(photo => [photo.id, photo.sort_order]), [['legacy-z', 0], ['legacy-a', 1]], 'Album sorting updates the authoritative work order');
    assert.deepEqual(owner.prepare("SELECT id,sort_order FROM photos WHERE series='editorial' ORDER BY id").all(), editorialOrderBefore, 'Sorting one series preserves all other series');
    assert.deepEqual(owner.prepare('SELECT id,album_order FROM photos ORDER BY id').all(), legacyAlbumOrder, 'Deprecated album metadata stays untouched');
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ ...edit, showOnWall: true }) })).status, 200);
    let sharedOrder = JSON.parse((await (await request('/yangyu')).text()).match(/<script id="gallery-data" type="application\/json">(.*?)<\/script>/s)[1]).photos.filter(photo => photo.series === 'scene');
    assert.deepEqual(sharedOrder.map(photo => photo.id), ['legacy-z', 'legacy-a'], 'The first photo now supplies the series cover');
    assert.deepEqual(sharedOrder.filter(photo => photo.showOnWall).map(photo => photo.id), ['legacy-z', 'legacy-a'], 'The public wall receives the same saved order');
    owner.prepare('INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES (?,?,?,?,?,?,1,?,?)')
      .run('appended', 'scene', 'New photo', 'New photo', '/assets/scene-01.jpg', 'Owner', 99, '2026-01-01T00:00:00.000Z');
    assert.equal(owner.prepare("SELECT album_order FROM photos WHERE id='appended'").get().album_order, 3, 'Every insert path appends in the album');
    assert.equal((await order(adminHeaders, { series: 'scene', ids: ['legacy-z', 'legacy-a'] })).status, 409, 'A concurrent upload cannot be dropped by an old complete list');
    assert.equal((await request('/api/admin/order', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ series: 'scene', ids: ['appended', 'legacy-z', 'legacy-a'] }) })).status, 200);
    const afterWorkOrder = await albumData('/yangyu/album?series=scene');
    assert.deepEqual(afterWorkOrder.photos.filter(photo => photo.series === 'scene').map(photo => photo.id), ['appended', 'legacy-z', 'legacy-a'], 'The work-order endpoint immediately updates the public album too');
    assert.equal((await order(adminHeaders, { series: 'scene', ids: ['legacy-a', 'appended', 'legacy-z'] })).status, 200);
    sharedOrder = JSON.parse((await (await request('/yangyu')).text()).match(/<script id="gallery-data" type="application\/json">(.*?)<\/script>/s)[1]).photos.filter(photo => photo.series === 'scene');
    assert.deepEqual(sharedOrder.map(photo => photo.id), ['legacy-a', 'appended', 'legacy-z']);
    assert.deepEqual(sharedOrder.filter(photo => photo.showOnWall).map(photo => photo.id), ['legacy-a', 'appended', 'legacy-z'], 'Album saves also replace the wall order and first-photo cover');
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ ...edit, series: 'editorial' }) })).status, 200);
    assert.equal((await gallery(adminHeaders)).find(photo => photo.id === edit.id).sortOrder, 7, 'Moving to another series appends after that series saved work order');
    const invitation = await (await request('/api/platform/invitations', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ count: 1, days: 7, quotaBytes: 10000, note: 'Album isolation' }) })).json();
    assert.equal((await request('/register', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'other-album', displayName: 'Other album', password, passwordConfirmation: password, invitation: invitation.codes[0] }) })).status, 303);
    const otherHeaders = await signIn('other-album');
    const catalog = new DatabaseSync(resolve(data, 'platform.sqlite')); databases.push(catalog);
    const otherAccount = catalog.prepare("SELECT id,storage_id FROM users WHERE public_id='other-album'").get();
    const other = new DatabaseSync(resolve(data, 'photographers', otherAccount.storage_id, 'gallery.sqlite')); databases.push(other);
    other.prepare("INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES ('other-photo','scene','Only other','Only other','/assets/scene-01.jpg','Other',1,0,'2020-01-01')").run();
    assert.equal((await albumData('/yangyu/album', otherHeaders)).canArrange, false);
    assert.equal((await albumData('/other-album/album', adminHeaders)).canArrange, false, 'Platform administrators do not reorder another photographer album');
    assert.equal((await albumData('/other-album/album', otherHeaders)).canArrange, false, 'Photographers also browse their public album without editing controls');
    const otherWorkspace = await albumData('/dashboard/album?publicId=yangyu&accountId=1', otherHeaders);
    assert.equal(otherWorkspace.canArrange, true);
    assert.equal(otherWorkspace.publicId, 'other-album');
    assert.deepEqual(otherWorkspace.photos.map(photo => photo.id), ['other-photo'], 'Workspace query parameters cannot select another account');
    assert.ok((await albumData('/dashboard/album?publicId=other-album', adminHeaders)).photos.every(photo => photo.id !== 'other-photo'));
    assert.equal((await order(otherHeaders, { series: 'scene', ids: ['legacy-z', 'appended'] })).status, 409);
    assert.equal((await order(adminHeaders, { series: 'scene', ids: ['other-photo'] })).status, 409);
    assert.equal((await order(otherHeaders, { series: 'scene', ids: ['other-photo'] })).status, 200);
    assert.equal((await request('/api/admin/photos', { method: 'PATCH', headers: otherHeaders, body: JSON.stringify(edit) })).status, 404);
    assert.deepEqual((await gallery(otherHeaders)).map(photo => photo.id), ['other-photo']);
    const account = (await (await request('/api/session', { headers: adminHeaders })).json()).account;
    assert.equal((await request('/api/profile', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ displayName: account.displayName, publicId: 'legacy-album', bio: '', listed: true }) })).status, 200);
    for (const path of ['/yangyu/album', '/legacy-album/album']) assert.equal((await albumData(path, adminHeaders)).publicId, 'legacy-album');
    assert.equal((await albumData('/dashboard/album', adminHeaders)).publicId, 'legacy-album');
    assert.equal((await request('/api/platform/accounts', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ id: otherAccount.id, action: 'disable' }) })).status, 200);
    assert.equal((await request('/other-album/album')).status, 404);
    assert.equal((await request('/dashboard/album', { headers: otherHeaders })).status, 303);
    const saved = await gallery(adminHeaders);
    const identities = catalog.prepare('SELECT id,storage_id FROM users ORDER BY id').all();
    await stopServer();
    await startServer();
    assert.deepEqual(await gallery(adminHeaders), saved, 'Restart keeps the shared work order and wall settings');
    assert.deepEqual(catalog.prepare('SELECT id,storage_id FROM users ORDER BY id').all(), identities);
    assert.equal(owner.prepare("SELECT COUNT(*) AS count FROM server_migrations WHERE name='0003'").get().count, 1);
    assert.equal(await readFile(callsPath, 'utf8'), '');
    owner.exec('DELETE FROM photos; DELETE FROM series;');
    for (const path of ['/legacy-album/album', '/dashboard/album']) {
      const response = await request(path, { headers: adminHeaders });
      assert.equal(response.status, 200);
      const html = await response.text();
      const emptyAlbum = JSON.parse(html.match(/<script id="album-data" type="application\/json">(.*?)<\/script>/s)[1]);
      assert.equal(emptyAlbum.selectedSeriesId, '');
      assert.deepEqual(emptyAlbum.series, []);
      assert.deepEqual(emptyAlbum.photos, []);
      assert.ok(html.includes('<nav class="album-series" aria-label="相册系列"></nav>'), 'An empty gallery has no aggregate or invalid series tab');
    }
  } finally {
    await stopServer();
    for (const database of databases) database.close();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-album-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

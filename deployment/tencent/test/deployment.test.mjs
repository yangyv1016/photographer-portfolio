import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('Tencent runtime preserves gallery management and rejects unauthorized actions', async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-deployment-test-'));
  const origin = 'http://127.0.0.1:18087';
  const password = randomBytes(9).toString('base64url');
  const environment = { ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18087', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu', COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key' };
  let server;
  let database;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'test-admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    server = spawn(process.execPath, ['app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolveReady, reject) => {
      server.stdout.once('data', resolveReady);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Server exited before readiness: ${code}`)));
    });
    database = new DatabaseSync(resolve(data, 'gallery.sqlite'));
    const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
    for (const path of ['/api/admin/photos', '/api/admin/export', '/api/admin/export-image?id=unknown', '/api/profile/cover', '/admin.js', '/admin-client.js']) {
      assert.equal((await request(path, { headers: { 'oai-authenticated-user-email': 'owner@example.test' } })).status, 401, path);
    }
    assert.equal((await request('/admin')).status, 303);
    assert.equal((await request('/.env')).status, 404);
    const homepage = await (await request('/')).text();
    assert.ok(!homepage.includes('导出拼图') && !homepage.includes('慢慢看，慢慢相遇'));
    assert.equal((await request('/api/photos')).status, 200);
    const login = await request('/admin/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'test-admin', password }) });
    assert.equal(login.status, 303);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await request('/api/admin/initialize', { method: 'POST', headers })).status, 200);
    assert.equal((await request('/admin', { headers })).status, 200);
    const exportResponse = await request('/api/admin/export', { headers });
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get('cache-control'), 'private, no-store');
    const exportScript = await exportResponse.text();
    for (const control of ['pageCount', 'export-arrange-tab', 'export-preview-tab', 'export-photo-grid', 'export-move-position', 'export-page-group', 'getExportGroups']) {
      assert.ok(exportScript.includes(control), `Authenticated export script includes ${control}`);
    }
    assert.equal((await request('/api/admin/export-image?id=unknown', { headers })).status, 404);
    assert.equal((await request('/api/admin/series', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.test' }, body: JSON.stringify({ name: 'Blocked', description: '' }) })).status, 403);
    const create = await request('/api/admin/series', { method: 'POST', headers, body: JSON.stringify({ name: '夜景 </script>', description: 'test' }) });
    assert.equal(create.status, 201);
    const { id } = await create.json();
    assert.equal((await request('/api/admin/series', { method: 'POST', headers, body: JSON.stringify({ name: '夜景 </script>', description: '' }) })).status, 409);
    const insert = database.prepare("INSERT INTO photos (id,series,title,alt,src,photographer,is_sample,sort_order,created_at) VALUES (?,?,'Test','Test','/assets/scene-01.jpg','Test',1,?,?)");
    insert.run('test-source', id, 0, new Date().toISOString());
    insert.run('test-destination', 'scene', 0, new Date().toISOString());
    const removeWithoutDestination = await request('/api/admin/series', { method: 'DELETE', headers, body: JSON.stringify({ id }) });
    assert.equal(removeWithoutDestination.status, 409);
    const moved = await request('/api/admin/series', { method: 'DELETE', headers, body: JSON.stringify({ id, moveTo: 'scene' }) });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).moved, 1);
    assert.deepEqual(database.prepare('SELECT id FROM photos WHERE series = ? ORDER BY sort_order').all('scene').map(row => row.id), ['test-destination', 'test-source']);
    const edit = await request('/api/admin/photos', { method: 'PATCH', headers, body: JSON.stringify({ id: 'test-source', title: 'Renamed', alt: 'Photo', series: 'editorial' }) });
    assert.equal(edit.status, 200);
    assert.equal((await request('/api/admin/batch', { method: 'POST', headers, body: JSON.stringify({ action: 'move', ids: ['test-source', 'test-destination'], series: 'editorial' }) })).status, 200);
    const uploadId = crypto.randomUUID();
    database.prepare("INSERT INTO photo_uploads VALUES (?, 'cos-task', 'photos/test.jpg', 'scene', 'Large photo', 'image/jpeg', 27000000, ?)").run(uploadId, new Date().toISOString());
    const signed = await request(`/api/admin/upload-part?id=${uploadId}&part=4`, { headers });
    assert.equal(signed.status, 200);
    const signedLocation = new URL((await signed.json()).url);
    assert.equal(signedLocation.searchParams.get('uploadId'), 'cos-task');
    assert.equal(signedLocation.searchParams.get('partNumber'), '4');
    assert.ok(signedLocation.searchParams.has('q-signature'));
    assert.ok(signedLocation.searchParams.get('q-header-list').split(';').includes('content-length'));
    assert.equal((await request(`/api/admin/upload-part?id=${uploadId}&part=5`, { headers })).status, 400);
    const backup = spawn(process.execPath, ['app/backup.mjs'], { cwd: directory, env: environment, stdio: 'ignore' });
    assert.equal((await once(backup, 'exit'))[0], 0);
    const platformFiles = await readdir(resolve(data, 'backups/platform'));
    const galleryFiles = await readdir(resolve(data, 'backups/photographer-1'));
    const platformBackup = new DatabaseSync(resolve(data, 'backups/platform', platformFiles[0]));
    const galleryBackup = new DatabaseSync(resolve(data, 'backups/photographer-1', galleryFiles[0]));
    try {
      assert.equal(platformBackup.prepare('SELECT login_id FROM users WHERE id=1').get().login_id,'test-admin');
      assert.equal(galleryBackup.prepare('SELECT title FROM photos WHERE id=?').get('test-source').title,'Renamed');
    } finally { platformBackup.close(); galleryBackup.close(); }
    assert.equal((await request('/admin/logout', { method: 'POST', headers })).status, 303);
    assert.equal((await request('/api/admin/photos', { headers })).status, 401);
  } finally {
    database?.close();
    if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); }
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-deployment-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Local object storage confines paths, verifies parts and keeps originals private', async t => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-local-unit-'));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { STORAGE_BACKEND: 'local', YANGYU_ROOT: data, DATA_DIRECTORY: data });
    for (const name of ['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) delete process.env[name];
    const { env, objectHead, objectResponse, readObjectPrefix, signedUrl } = await import('../storage.mjs');
    const bytes = Buffer.from([255, 216, 255, 10, 20, 30]);
    await env.BUCKET.put('photos/probe.jpg', bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    assert.equal((await objectHead('photos/probe.jpg')).size, bytes.length);
    assert.deepEqual(await readObjectPrefix('photos/probe.jpg', 3), bytes.subarray(0, 3));
    const response = await objectResponse('photos/probe.jpg');
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await assert.rejects(async () => signedUrl('photos/probe.jpg'));
    for (const key of ['../escape.jpg', '/photos/escape.jpg', 'photos/../escape.jpg', 'photos/../../platform.sqlite', 'photos\\escape.jpg', 'photos/C:escape.jpg', 'photos//escape.jpg', 'photos/./escape.jpg', 'photos/\0escape.jpg']) {
      await assert.rejects(async () => objectHead(key), key);
      await assert.rejects(async () => env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } }), key);
      await assert.rejects(async () => env.BUCKET.delete(key), key);
    }
    const upload = await env.BUCKET.createMultipartUpload('photos/chunked.jpg', { httpMetadata: { contentType: 'image/jpeg' } });
    const first = await upload.uploadPart(1, bytes.subarray(0, 3));
    const second = await upload.uploadPart(2, bytes.subarray(3));
    await assert.rejects(() => upload.complete([first, { ...second, etag: 'incorrect-etag' }]));
    assert.equal(await objectHead('photos/chunked.jpg'), null, 'A failed completion exposes no partial original');
    await env.BUCKET.resumeMultipartUpload('photos/chunked.jpg', upload.uploadId).complete([first, second]);
    assert.deepEqual(await readFile(resolve(data, 'objects/photos/chunked.jpg')), bytes);
    await t.test('A committed image remains successful when temporary part cleanup fails', async () => {
      const remove = fs.promises.rm;
      const warnings = [];
      const log = t.mock.method(console, 'error', message => warnings.push(message));
      fs.promises.rm = async (path, options) => {
        if (options?.recursive && dirname(path) === resolve(data, 'multipart')) throw Object.assign(new Error('Cleanup blocked'), { code: 'EACCES' });
        return remove(path, options);
      };
      syncBuiltinESMExports();
      try {
        await env.BUCKET.put('photos/committed.jpg', bytes, { httpMetadata: { contentType: 'image/jpeg' } });
        assert.deepEqual(Buffer.from(await (await objectResponse('photos/committed.jpg')).arrayBuffer()), bytes);
        assert.equal(warnings.length, 1);
      } finally {
        fs.promises.rm = remove;
        syncBuiltinESMExports();
        log.mock.restore();
      }
      const stages = await readdir(resolve(data, 'multipart'));
      assert.equal(stages.length, 1);
      const committed = env.BUCKET.resumeMultipartUpload('photos/committed.jpg', stages[0]);
      const part = await committed.uploadPart(1, bytes);
      await committed.complete([part]);
      assert.deepEqual(await readdir(resolve(data, 'multipart')), []);
      await env.BUCKET.delete('photos/committed.jpg');
    });
    await assert.rejects(async () => env.BUCKET.resumeMultipartUpload('photos/chunked.jpg', '../outside').abort());
    const mismatched = await env.BUCKET.createMultipartUpload('photos/bound.jpg', { httpMetadata: { contentType: 'image/jpeg' } });
    await assert.rejects(async () => env.BUCKET.resumeMultipartUpload('photos/different.jpg', mismatched.uploadId).uploadPart(1, bytes));
    await mismatched.abort();
    await t.test('Local object paths reject symlink parents', async t => {
      const outside = resolve(data, 'outside');
      await mkdir(outside);
      await copyFile(resolve(data, 'objects/photos/probe.jpg'), resolve(outside, 'probe.jpg'));
      await copyFile(resolve(data, 'objects/photos/probe.jpg.json'), resolve(outside, 'probe.jpg.json'));
      try { await symlink(outside, resolve(data, 'objects/photos/link'), 'junction'); }
      catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows does not permit this symlink probe.'); return; }
        throw error;
      }
      await assert.rejects(() => objectHead('photos/link/probe.jpg'));
      await assert.rejects(() => env.BUCKET.delete('photos/link/probe.jpg'));
      assert.deepEqual(await readFile(resolve(outside, 'probe.jpg')), bytes);
    });
    await env.BUCKET.delete(['photos/probe.jpg', 'photos/chunked.jpg']);
    assert.equal(await objectHead('photos/probe.jpg'), null);
    assert.equal(await objectHead('photos/chunked.jpg'), null);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-local-unit-'));
    await rm(data, { recursive: true, force: true });
  }
});

test('Local deployments upload, resume, preview, download and manage profile images without COS', { timeout: 40000 }, async () => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-local-http-'));
  const origin = 'http://127.0.0.1:18125';
  const password = randomBytes(18).toString('base64url');
  const environment = { ...process.env, STORAGE_BACKEND: 'local', YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18125' };
  for (const name of ['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) delete environment[name];
  let server, gallery, catalog;
  const calls = resolve(data, 'forbidden-cos-calls.txt');
  const stub = resolve(data, 'no-cos.mjs');
  async function startServer() {
    server = spawn(process.execPath, ['--import', pathToFileURL(stub).href, 'app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Local server failed (${code}): ${errors}`)));
    });
  }
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'local-admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    await writeFile(stub, `import COS from ${JSON.stringify(pathToFileURL(resolve(directory, 'node_modules/cos-nodejs-sdk-v5/index.js')).href)};
import {appendFileSync} from 'node:fs';
const deny=name=>{appendFileSync(${JSON.stringify(calls)},name+'\\n');throw new Error('Unexpected COS operation: '+name);};
for(const name of ['headObject','getObject','getObjectUrl','multipartInit','multipartUpload','multipartComplete','multipartAbort','deleteObject','deleteMultipleObject'])COS.prototype[name]=()=>deny(name);
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost'].includes(url.hostname))return deny('external-fetch');return originalFetch(input,options);};`);
    await startServer();
    const login = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'local-admin', password }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const partHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream' };
    assert.equal((await (await request('/api/platform/overview', { headers })).json()).storageBackend, 'local');
    const jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#91a3b4' } }).jpeg().toBuffer();
    const original = Buffer.concat([jpeg, Buffer.alloc(8 * 1024 ** 2 + 33 - jpeg.length)]);
    const created = await request('/api/admin/uploads', { method: 'POST', headers, body: JSON.stringify({ series: 'scene', title: 'Local original', contentType: 'image/jpeg', size: original.length }) });
    assert.equal(created.status, 201);
    const task = await created.json();
    const endpoint = `/api/admin/upload-part?id=${task.id}&part=`;
    assert.equal((await request(endpoint + '1', { headers })).status, 405, 'Local mode never hands out object URLs');
    assert.equal((await request(endpoint + '1', { method: 'PUT', headers: { Origin: origin }, body: original.subarray(0, task.partSize) })).status, 401);
    assert.equal((await request(endpoint + '1', { method: 'PUT', headers: { ...partHeaders, Origin: 'https://attacker.test' }, body: original.subarray(0, task.partSize) })).status, 403);
    const first = await (await request(endpoint + '1', { method: 'PUT', headers: partHeaders, body: original.subarray(0, task.partSize) })).json();
    server.kill(); await once(server, 'exit');
    await startServer();
    const second = await (await request(endpoint + '2', { method: 'PUT', headers: partHeaders, body: original.subarray(task.partSize) })).json();
    const parts = [{ partNumber: 1, etag: first.etag }, { partNumber: 2, etag: second.etag }];
    const finish = await request('/api/admin/uploads', { method: 'PATCH', headers, body: JSON.stringify({ id: task.id, parts }) });
    assert.equal(finish.status, 201, await finish.text());
    gallery = new DatabaseSync(resolve(data, 'gallery.sqlite'));
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    const key = gallery.prepare('SELECT image_key FROM photos WHERE id=?').get(task.id).image_key;
    assert.deepEqual(await readFile(resolve(data, 'objects', key)), original);
    const photo = (await (await request('/api/admin/photos', { headers })).json()).photos.find(photo => photo.id === task.id);
    assert.deepEqual(Buffer.from(await (await request(photo.src)).arrayBuffer()), original);
    const download = await request(photo.downloadSrc, { headers });
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const preview = await request(photo.thumbnailSrc);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 1280);
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#aabbee' } }).png().toBuffer();
    for (const [field, route] of [['avatar', 'avatars'], ['cover', 'covers'], ['directory-cover', 'directory-covers']]) {
      const uploaded = await request('/api/profile/' + field, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'image/png' }, body: png });
      assert.equal(uploaded.status, 200, field);
      assert.deepEqual(Buffer.from(await (await request(`/api/${route}/yangyu`)).arrayBuffer()), png);
    }
    const invitation = await (await request('/api/platform/invitations', { method: 'POST', headers, body: JSON.stringify({ count: 1, days: 7, quotaBytes: 10000, note: 'Local isolation' }) })).json();
    const registered = await request('/register', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'localother', displayName: 'Other', password, passwordConfirmation: password, invitation: invitation.codes[0] }) });
    assert.equal(registered.status, 303);
    const otherCookie = registered.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(photo.downloadSrc, { headers: { Cookie: otherCookie } })).status, 404);
    assert.equal((await request(`/api/media/localother/${task.id}`)).status, 404);
    for (const path of [`/objects/${key}`, `/objects/${key}.json`, `/api/media/yangyu/${encodeURIComponent('../platform.sqlite')}`]) assert.equal((await request(path)).status, 404);
    catalog.prepare('UPDATE users SET quota_bytes=1 WHERE id=1').run();
    assert.equal((await request('/api/admin/uploads', { method: 'POST', headers, body: JSON.stringify({ series: 'scene', title: 'Over quota', contentType: 'image/png', size: png.length }) })).status, 413);
    catalog.prepare('UPDATE users SET quota_bytes=? WHERE id=1').run(5 * 1024 ** 3);
    const pending = await (await request('/api/admin/uploads', { method: 'POST', headers, body: JSON.stringify({ series: 'scene', title: 'Cancel local upload', contentType: 'image/png', size: png.length }) })).json();
    assert.equal((await request(`/api/admin/upload-part?id=${pending.id}&part=1`, { method: 'PUT', headers: partHeaders, body: png })).status, 200);
    assert.equal((await request('/api/admin/uploads', { method: 'DELETE', headers, body: JSON.stringify({ id: pending.id }) })).status, 200);
    assert.deepEqual(await readdir(resolve(data, 'multipart')), []);
    server.kill(); await once(server, 'exit');
    await startServer();
    assert.deepEqual(Buffer.from(await (await request(photo.src)).arrayBuffer()), original, 'Original and metadata survive restart');
    assert.equal((await request('/api/admin/photos', { method: 'DELETE', headers, body: JSON.stringify({ id: task.id }) })).status, 200);
    assert.equal((await request(photo.src)).status, 404);
    await assert.rejects(() => readFile(resolve(data, 'objects', key)), { code: 'ENOENT' });
    await assert.rejects(() => readFile(resolve(data, 'objects', key + '.json')), { code: 'ENOENT' });
    await assert.rejects(() => readFile(calls), { code: 'ENOENT' }, 'Local mode must not call COS');
  } finally {
    gallery?.close(); catalog?.close();
    if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); }
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-local-http-'));
    await rm(data, { recursive: true, force: true });
  }
});

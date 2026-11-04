import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Public visits deduplicate by browser, photographer and Shanghai day with private scoped reporting', { timeout: 30000 }, async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-visits-test-'));
  const origin = 'http://127.0.0.1:18126';
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18126',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu', COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const clock = resolve(data, 'clock.txt');
  const clockStub = resolve(data, 'clock.mjs');
  const beforeMidnight = Date.parse('2026-11-03T15:59:59Z');
  const setClock = time => writeFile(clock, String(time));
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const visit = (id, cookie, headers = {}) => request(`/api/visits/${id}`, {
    method: 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const stats = (cookie, query = '') => request(`/api/profile/visits${query}`, { headers: { Cookie: cookie } });
  let server;
  let catalog;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    await setClock(beforeMidnight);
    await writeFile(clockStub, `import { readFileSync } from 'node:fs';
Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
`);
    server = spawn(process.execPath, ['--import', pathToFileURL(clockStub).href, 'app/server.mjs'], {
      cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Server failed: ${code}`)));
    });
    const adminLogin = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(adminLogin.status, 303);
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
    const adminHeaders = { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' };
    const invite = await request('/api/platform/invitations', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ count: 2, days: 7, quotaBytes: 10000, note: 'Visit test' }),
    });
    assert.equal(invite.status, 201);
    const { codes } = await invite.json();
    const photographers = [];
    for (const [index, username] of ['alicia', 'boris'].entries()) {
      const registered = await request('/register', {
        method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({
          username, displayName: username, password, passwordConfirmation: password, invitation: codes[index],
        }),
      });
      assert.equal(registered.status, 303);
      const cookie = registered.headers.get('set-cookie').split(';')[0];
      const { account } = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
      photographers.push({ cookie, account });
    }
    const [alicia, boris] = photographers;

    assert.equal((await request('/api/profile/visits')).status, 401);
    assert.equal((await request('/api/visits/alicia')).status, 405);
    assert.equal((await visit('alicia', null, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await visit('missing')).status, 404);
    assert.equal((await request('/alicia')).status, 200);
    const initial = await (await stats(adminCookie)).json();
    assert.equal(initial.availableFrom, '2026-11-03');
    assert.equal(initial.days.length, 30);
    assert.equal(initial.today, 0);
    assert.equal(initial.total, 0);

    const firstVisit = await visit('alicia');
    assert.equal(firstVisit.status, 200);
    assert.match(firstVisit.headers.get('cache-control'), /no-store/);
    const issuedCookie = firstVisit.headers.get('set-cookie');
    assert.match(issuedCookie, /^yangyu_visitor=[a-f0-9]{32}\.[a-f0-9]{64}; Path=\/api\/visits; HttpOnly; SameSite=Strict;/);
    const browserCookie = issuedCookie.split(';')[0];
    assert.deepEqual(await firstVisit.json(), { today: 1 });
    const repeated = await visit('alicia', browserCookie);
    assert.equal(repeated.headers.get('set-cookie'), null);
    assert.deepEqual(await repeated.json(), { today: 1 });
    assert.deepEqual(await (await visit('boris', browserCookie)).json(), { today: 1 });
    const forgedCookie = `yangyu_visitor=${'a'.repeat(32)}.${'b'.repeat(64)}`;
    const secondBrowser = await visit('alicia', forgedCookie);
    assert.notEqual(secondBrowser.headers.get('set-cookie').split(';')[0], forgedCookie);
    assert.deepEqual(await secondBrowser.json(), { today: 2 });

    const own = await (await stats(alicia.cookie, '?days=7')).json();
    assert.deepEqual(own.accounts, []);
    assert.equal(own.today, 2);
    assert.equal(own.days.length, 7);
    assert.equal((await stats(alicia.cookie, `?accountId=${boris.account.id}`)).status, 403);
    assert.equal((await stats(adminCookie, '?days=15')).status, 400);
    assert.equal((await stats(adminCookie, '?accountId=99999')).status, 404);
    const global = await (await stats(adminCookie, '?days=7')).json();
    assert.equal(global.today, 2, 'One browser that visits two photographers counts once globally');
    assert.equal(global.total, 2);
    assert.deepEqual(global.accounts.map(item => item.publicId).sort(), ['alicia', 'boris', 'yangyu']);
    const scoped = await (await stats(adminCookie, `?accountId=${boris.account.id}`)).json();
    assert.equal(scoped.today, 1);

    const rename = await request('/api/profile', {
      method: 'PATCH', headers: { Origin: origin, Cookie: alicia.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alicia', publicId: 'alicia-new', bio: '', listed: true }),
    });
    assert.equal(rename.status, 200);
    assert.deepEqual(await (await visit('alicia', browserCookie)).json(), { today: 2 });
    assert.deepEqual(await (await visit('alicia-new', browserCookie)).json(), { today: 2 });
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count, 3);
    assert.ok(catalog.prepare('SELECT visitor_hash FROM daily_visits').all().every(row => /^[a-f0-9]{64}$/.test(row.visitor_hash)));
    catalog.prepare('UPDATE users SET is_active=0, deleted_at=? WHERE id=?').run('2026-11-03T15:59:59Z', boris.account.id);
    assert.equal((await visit('boris', browserCookie)).status, 404);
    assert.equal((await (await stats(adminCookie, `?accountId=${boris.account.id}`)).json()).today, 1);

    await setClock(beforeMidnight + 2000);
    assert.deepEqual(await (await visit('alicia-new', browserCookie)).json(), { today: 1 });
    const nextDay = await (await stats(adminCookie, '?days=7')).json();
    assert.deepEqual(nextDay.days.slice(-2), [{ date: '2026-11-03', visitors: 2 }, { date: '2026-11-04', visitors: 1 }]);
    assert.equal(nextDay.total, 3);

    const rateHeaders = { 'X-Forwarded-For': '198.51.100.77' };
    for (let count = 0; count < 30; count++) assert.equal((await visit('alicia-new', null, rateHeaders)).status, 200);
    assert.equal((await visit('alicia-new', null, rateHeaders)).status, 429);
    assert.equal((await visit('alicia-new', browserCookie, rateHeaders)).status, 200);

    await setClock(beforeMidnight + 91 * 86400000);
    const relogin = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(relogin.status, 303);
    const remaining = await (await stats(relogin.headers.get('set-cookie').split(';')[0], '?days=90')).json();
    assert.equal(remaining.days.length, 90);
    assert.equal(remaining.total, 0);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count, 0);
  } finally {
    catalog?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-visits-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

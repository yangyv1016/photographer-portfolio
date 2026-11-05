import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:18126';
const beforeMidnight = Date.parse('2026-11-03T15:59:59Z');

async function startServer(environment, clockStub) {
  const server = spawn(process.execPath, ['--import', pathToFileURL(clockStub).href, 'app/server.mjs'], {
    cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((ready, reject) => {
    server.stdout.once('data', ready);
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Visits server failed (' + code + '): ' + errors)));
  });
  return server;
}

async function stopServer(server) {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}

test('Daily IP visits persist counters, normalize addresses and remain atomic across processes', { timeout: 45000 }, async () => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-visits-test-'));
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18126',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const clock = resolve(data, 'clock.txt');
  const clockStub = resolve(data, 'clock.mjs');
  const setClock = time => writeFile(clock, String(time));
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const visit = (id, ip, cookie, headers = {}) => request('/api/visits/' + id, {
    method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const stats = (cookie, query = '') => request('/api/profile/visits' + query, { headers: { Cookie: cookie } });
  let server, parallelServer, catalog;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    await setClock(beforeMidnight);
    await writeFile(clockStub, "import { readFileSync } from 'node:fs';\nDate.now = () => Number(readFileSync(" + JSON.stringify(clock) + ", 'utf8'));\n");
    server = await startServer(environment, clockStub);
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
    const addressA = '198.51.100.11';
    const addressB = '198.51.100.12';
    const ignoredCookie = 'yangyu_visitor=' + 'a'.repeat(32) + '.' + 'b'.repeat(64);

    assert.equal((await request('/api/profile/visits')).status, 401);
    assert.equal((await request('/api/visits/alicia')).status, 405);
    assert.equal((await visit('alicia', addressA, null, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await visit('missing', addressA)).status, 404);
    const initial = await (await stats(adminCookie)).json();
    assert.equal(initial.availableFrom, '2026-11-03');
    assert.equal(initial.ipDedupFrom, '2026-11-03');
    assert.equal(initial.todayDeduplication, 'ip');
    assert.equal(initial.days.length, 30);
    assert.equal(initial.today, 0);
    assert.equal(initial.total, 0);

    const first = await visit('alicia', addressA);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control'), /no-store/);
    assert.equal(first.headers.get('set-cookie'), null);
    assert.deepEqual(await first.json(), { today: 1 });
    assert.deepEqual(await (await visit('alicia', addressA, ignoredCookie)).json(), { today: 1 });
    assert.deepEqual(await (await visit('alicia', addressA)).json(), { today: 1 });
    assert.deepEqual(await (await visit('alicia', addressB, ignoredCookie)).json(), { today: 2 });
    assert.deepEqual(await (await visit('boris', addressA, ignoredCookie)).json(), { today: 1 });
    for (const address of ['::ffff:198.51.100.11', '::ffff:c633:640b', '198.51.100.11, 203.0.113.9']) {
      assert.deepEqual(await (await visit('alicia', address)).json(), { today: 2 });
    }
    assert.deepEqual(await (await visit('alicia', '2001:0DB8:0000:0000:0000:0000:0000:0001')).json(), { today: 3 });
    assert.deepEqual(await (await visit('alicia', '2001:db8::1', ignoredCookie)).json(), { today: 3 });
    for (const address of ['invalid-ip', '198.51.100.999', '2001:::db8', '198.51.100.11:443', '127.1', '010.0.0.1']) {
      assert.equal((await visit('alicia', address)).status, 400, address);
    }

    const own = await (await stats(alicia.cookie, '?days=7')).json();
    assert.deepEqual(own.accounts, []);
    assert.equal(own.today, 3);
    assert.equal(own.days.length, 7);
    assert.equal((await stats(alicia.cookie, '?accountId=' + boris.account.id)).status, 403);
    assert.equal((await stats(adminCookie, '?days=15')).status, 400);
    assert.equal((await stats(adminCookie, '?accountId=99999')).status, 404);
    const global = await (await stats(adminCookie, '?days=7')).json();
    assert.equal(global.today, 3, 'An IP that visits two photographers counts once globally');
    assert.equal(global.total, 3);
    assert.deepEqual(global.accounts.map(item => item.publicId).sort(), ['alicia', 'boris', 'yangyu']);
    assert.equal((await (await stats(adminCookie, '?accountId=' + boris.account.id)).json()).today, 1);

    const rename = await request('/api/profile', {
      method: 'PATCH', headers: { Origin: origin, Cookie: alicia.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alicia', publicId: 'alicia-new', bio: '', listed: true }),
    });
    assert.equal(rename.status, 200);
    assert.deepEqual(await (await visit('alicia', addressA)).json(), { today: 3 });
    assert.deepEqual(await (await visit('alicia-new', addressA)).json(), { today: 3 });

    const parallelOrigin = 'http://127.0.0.1:18127';
    parallelServer = await startServer({ ...environment, PUBLIC_ORIGIN: parallelOrigin, PORT: '18127' }, clockStub);
    const concurrent = await Promise.all(Array.from({ length: 70 }, (_, index) => {
      const selectedOrigin = index % 2 ? origin : parallelOrigin;
      return fetch(selectedOrigin + '/api/visits/alicia-new', {
        method: 'POST', headers: { Origin: selectedOrigin, 'X-Forwarded-For': '198.51.100.13' },
      });
    }));
    for (const response of concurrent) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { today: 4 });
    }
    assert.equal((await (await stats(adminCookie)).json()).today, 4);
    await stopServer(parallelServer);
    await stopServer(server);
    server = await startServer(environment, clockStub);
    assert.equal((await (await stats(adminCookie)).json()).today, 4);
    assert.deepEqual(await (await visit('alicia-new', '198.51.100.13')).json(), { today: 4 });

    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    const visitsBeforeFailure = catalog.prepare('SELECT * FROM daily_visits ORDER BY visit_date,visitor_hash,storage_id').all();
    const totalsBeforeFailure = catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all();
    catalog.exec("CREATE TRIGGER fail_global_visit_total BEFORE INSERT ON daily_visit_totals WHEN NEW.scope_id = '' BEGIN SELECT RAISE(ABORT, 'Test global counter failure'); END;");
    assert.equal((await visit('alicia-new', '198.51.100.14')).status, 503);
    assert.deepEqual(catalog.prepare('SELECT * FROM daily_visits ORDER BY visit_date,visitor_hash,storage_id').all(), visitsBeforeFailure);
    assert.deepEqual(catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all(), totalsBeforeFailure);
    catalog.exec('DROP TRIGGER fail_global_visit_total');
    assert.deepEqual(await (await visit('alicia-new', '198.51.100.14')).json(), { today: 5 });
    assert.deepEqual(await (await visit('alicia-new', '198.51.100.14')).json(), { today: 5 });
    assert.equal((await (await stats(adminCookie)).json()).today, 5);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count, 6);
    assert.ok(catalog.prepare('SELECT visitor_hash FROM daily_visits').all().every(row => /^[a-f0-9]{64}$/.test(row.visitor_hash)));

    catalog.prepare('UPDATE users SET is_active=0,deleted_at=? WHERE id=?').run('2026-11-03T15:59:59Z', boris.account.id);
    assert.equal((await visit('boris', addressA)).status, 404);
    assert.equal((await (await stats(adminCookie, '?accountId=' + boris.account.id)).json()).today, 1);
    await setClock(beforeMidnight + 2000);
    assert.deepEqual(await (await visit('alicia-new', addressA, ignoredCookie)).json(), { today: 1 });
    const nextDay = await (await stats(adminCookie, '?days=7')).json();
    assert.deepEqual(nextDay.days.slice(-2), [{ date: '2026-11-03', visitors: 5 }, { date: '2026-11-04', visitors: 1 }]);
    assert.equal(nextDay.total, 6);
    assert.equal(nextDay.todayDeduplication, 'ip');
    const previousHashes = new Set(visitsBeforeFailure.map(row => row.visitor_hash));
    assert.ok(!previousHashes.has(catalog.prepare("SELECT visitor_hash FROM daily_visits WHERE visit_date='2026-11-04'").get().visitor_hash));

    await setClock(beforeMidnight + 91 * 86400000);
    const relogin = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(relogin.status, 303);
    const remaining = await (await stats(relogin.headers.get('set-cookie').split(';')[0], '?days=90')).json();
    assert.equal(remaining.days.length, 90);
    assert.equal(remaining.total, 0);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits').get().count, 0);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visit_totals').get().count, 0);
  } finally {
    catalog?.close();
    await stopServer(parallelServer);
    await stopServer(server);
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-visits-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

test('Browser-era history migrates once and switches to IP deduplication at the next Shanghai midnight', { timeout: 45000 }, async () => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-visits-upgrade-test-'));
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18126',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const clock = resolve(data, 'clock.txt');
  const clockStub = resolve(data, 'clock.mjs');
  const setClock = time => writeFile(clock, String(time));
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const visit = (id, ip, cookie) => request('/api/visits/' + id, {
    method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
  });
  let server, catalog;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    const secondStorageId = randomUUID();
    const inserted = catalog.prepare("INSERT INTO users (login_id,public_id,storage_id,password_hash,display_name,role,quota_bytes,created_at) SELECT 'legacy-second','legacy-second',?,password_hash,'Legacy photographer','photographer',quota_bytes,created_at FROM users WHERE id=1").run(secondStorageId);
    const secondId = Number(inserted.lastInsertRowid);
    const secondGallery = resolve(data, 'photographers', secondStorageId);
    await mkdir(secondGallery, { recursive: true });
    new DatabaseSync(resolve(secondGallery, 'gallery.sqlite')).close();
    catalog.exec('CREATE TABLE visitor_settings (id INTEGER PRIMARY KEY CHECK (id=1), signing_key TEXT NOT NULL, available_from TEXT NOT NULL);' +
      'CREATE TABLE daily_visits (visit_date TEXT NOT NULL, visitor_hash TEXT NOT NULL, storage_id TEXT NOT NULL REFERENCES users(storage_id), PRIMARY KEY(visit_date,visitor_hash,storage_id)) WITHOUT ROWID;' +
      'CREATE INDEX daily_visits_account ON daily_visits(storage_id,visit_date);');
    const signingKey = randomBytes(32).toString('hex');
    const tokenA = randomBytes(16).toString('hex');
    const tokenB = randomBytes(16).toString('hex');
    const legacyCookie = 'yangyu_visitor=' + tokenA + '.' + createHmac('sha256', signingKey).update(tokenA).digest('hex');
    catalog.prepare('INSERT INTO visitor_settings VALUES (1,?,?)').run(signingKey, '2026-11-02');
    const insertLegacy = catalog.prepare('INSERT INTO daily_visits VALUES (?,?,?)');
    for (const [date, token, storageId] of [
      ['2026-11-02', tokenA, 'legacy-owner'], ['2026-11-02', tokenA, secondStorageId],
      ['2026-11-02', tokenB, 'legacy-owner'], ['2026-11-03', tokenA, 'legacy-owner'],
      ['2026-11-03', tokenA, secondStorageId],
    ]) {
      insertLegacy.run(date, createHash('sha256').update(date + ':' + token).digest('hex'), storageId);
    }
    await setClock(beforeMidnight);
    await writeFile(clockStub, "import { readFileSync } from 'node:fs';\nDate.now = () => Number(readFileSync(" + JSON.stringify(clock) + ", 'utf8'));\n");
    server = await startServer(environment, clockStub);
    const login = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(login.status, 303);
    const adminCookie = login.headers.get('set-cookie').split(';')[0];
    const stats = async (query = '') => (await request('/api/profile/visits' + query, { headers: { Cookie: adminCookie } })).json();
    const initial = await stats('?days=7');
    assert.equal(initial.availableFrom, '2026-11-02');
    assert.equal(initial.ipDedupFrom, '2026-11-04');
    assert.equal(initial.todayDeduplication, 'browser');
    assert.deepEqual(initial.days.slice(-2), [{ date: '2026-11-02', visitors: 2 }, { date: '2026-11-03', visitors: 1 }]);
    assert.equal(initial.total, 3);
    assert.equal((await stats('?accountId=' + secondId)).today, 1);
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM platform_migrations WHERE name='visitor-ip-daily-totals'").get().count, 1);

    const repeated = await visit('yangyu', '198.51.100.21', legacyCookie);
    assert.equal(repeated.headers.get('set-cookie'), null);
    assert.deepEqual(await repeated.json(), { today: 1 });
    assert.deepEqual(await (await visit('yangyu', '198.51.100.22', legacyCookie)).json(), { today: 1 });
    const secondBrowser = await visit('yangyu', '198.51.100.21');
    assert.equal(secondBrowser.status, 200);
    assert.match(secondBrowser.headers.get('set-cookie'), /^yangyu_visitor=[a-f0-9]{32}\.[a-f0-9]{64};/);
    const secondBrowserCookie = secondBrowser.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await secondBrowser.json(), { today: 2 });
    const forged = await visit('yangyu', '198.51.100.21', 'yangyu_visitor=' + 'a'.repeat(32) + '.' + 'b'.repeat(64));
    assert.equal(forged.status, 200);
    assert.deepEqual(await forged.json(), { today: 3 });
    for (let index = 0; index < 30; index++) assert.equal((await visit('yangyu', '198.51.100.77')).status, 200);
    assert.equal((await visit('yangyu', '198.51.100.77')).status, 429);
    assert.deepEqual(await (await visit('yangyu', '198.51.100.77', legacyCookie)).json(), { today: 33 });

    const totalsBeforeRestart = catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all();
    await stopServer(server);
    server = await startServer(environment, clockStub);
    assert.deepEqual(catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all(), totalsBeforeRestart);
    assert.equal((await stats()).ipDedupFrom, '2026-11-04');
    assert.equal((await stats()).today, 33);
    assert.deepEqual(await (await visit('yangyu', '198.51.100.21', secondBrowserCookie)).json(), { today: 33 });

    await setClock(beforeMidnight + 2000);
    const firstIp = await visit('yangyu', '198.51.100.21', legacyCookie);
    assert.equal(firstIp.headers.get('set-cookie'), null);
    assert.deepEqual(await firstIp.json(), { today: 1 });
    assert.deepEqual(await (await visit('yangyu', '198.51.100.21')).json(), { today: 1 });
    assert.deepEqual(await (await visit('yangyu', '198.51.100.21', secondBrowserCookie)).json(), { today: 1 });
    assert.deepEqual(await (await visit('legacy-second', '198.51.100.21', secondBrowserCookie)).json(), { today: 1 });
    assert.deepEqual(await (await visit('yangyu', '198.51.100.22', legacyCookie)).json(), { today: 2 });
    const switched = await stats('?days=7');
    assert.equal(switched.todayDeduplication, 'ip');
    assert.equal(switched.ipDedupFrom, '2026-11-04');
    assert.deepEqual(switched.days.slice(-3), [
      { date: '2026-11-02', visitors: 2 }, { date: '2026-11-03', visitors: 33 }, { date: '2026-11-04', visitors: 2 },
    ]);
    assert.equal(switched.total, 37);
    assert.equal((await stats('?accountId=' + secondId)).today, 1);
    await stopServer(server);
    server = await startServer(environment, clockStub);
    assert.equal((await stats()).today, 2);
    assert.equal((await stats()).ipDedupFrom, '2026-11-04');
    assert.deepEqual(await (await visit('yangyu', '198.51.100.21')).json(), { today: 2 });
    assert.equal(catalog.prepare('SELECT signing_key FROM visitor_settings WHERE id=1').get().signing_key, signingKey);
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM platform_migrations WHERE name='visitor-ip-daily-totals'").get().count, 1);
  } finally {
    catalog?.close();
    await stopServer(server);
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-visits-upgrade-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

test('Only a valid session for the homepage owner is excluded in browser and IP modes', { timeout: 45000 }, async () => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-visits-owner-test-'));
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18126',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const clock = resolve(data, 'clock.txt');
  const clockStub = resolve(data, 'clock.mjs');
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const login = async username => {
    const response = await request('/login', {
      method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username, password }),
    });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const visit = (id, ip, cookie) => request('/api/visits/' + id, {
    method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
  });
  let server, catalog;
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    catalog.exec('CREATE TABLE visitor_settings (id INTEGER PRIMARY KEY CHECK (id=1), signing_key TEXT NOT NULL, available_from TEXT NOT NULL);' +
      'CREATE TABLE daily_visits (visit_date TEXT NOT NULL, visitor_hash TEXT NOT NULL, storage_id TEXT NOT NULL REFERENCES users(storage_id), PRIMARY KEY(visit_date,visitor_hash,storage_id)) WITHOUT ROWID;' +
      'CREATE INDEX daily_visits_account ON daily_visits(storage_id,visit_date);');
    catalog.prepare('INSERT INTO visitor_settings VALUES (1,?,?)').run(randomBytes(32).toString('hex'), '2026-11-03');
    await writeFile(clock, String(beforeMidnight));
    await writeFile(clockStub, "import { readFileSync } from 'node:fs';\nDate.now = () => Number(readFileSync(" + JSON.stringify(clock) + ", 'utf8'));\n");
    server = await startServer(environment, clockStub);
    const adminCookie = await login('admin');
    const invitation = await request('/api/platform/invitations', {
      method: 'POST', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 2, days: 7, quotaBytes: 10000, note: 'Owner visit exclusion' }),
    });
    assert.equal(invitation.status, 201);
    const { codes } = await invitation.json();
    const accounts = [];
    for (const [index, username] of ['owner-user', 'other-login'].entries()) {
      const registered = await request('/register', {
        method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({
          username, displayName: username, password, passwordConfirmation: password, invitation: codes[index],
        }),
      });
      assert.equal(registered.status, 303);
      const cookie = registered.headers.get('set-cookie').split(';')[0];
      const { account } = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
      const renamed = await request('/api/profile', {
        method: 'PATCH', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: username, publicId: index ? 'other-page' : 'owner-page', bio: '', listed: true }),
      });
      assert.equal(renamed.status, 200);
      accounts.push({ cookie, account });
    }
    const [owner, other] = accounts;
    const originalStorageId = catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(owner.account.id).storage_id;
    const renameLogin = await request('/api/profile/login-id', {
      method: 'POST', headers: { Origin: origin, Cookie: owner.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: 'other-page', confirmationLoginId: 'other-page', currentPassword: password }),
    });
    assert.equal(renameLogin.status, 200);
    assert.equal(catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(owner.account.id).storage_id, originalStorageId);

    for (const [index, date] of ['2026-11-03', '2026-11-04'].entries()) {
      const now = beforeMidnight + index * 2000;
      await writeFile(clock, String(now));
      const ownerCookie = await login('other-page');
      const otherCookie = await login('other-login');
      const currentAdminCookie = await login('admin');
      const identity = await (await request('/api/session', { headers: { Cookie: ownerCookie } })).json();
      assert.equal(identity.account.id, owner.account.id);
      assert.equal(identity.account.loginId, 'other-page');
      assert.equal(identity.account.publicId, 'owner-page');
      const statistics = await (await request('/api/profile/visits', { headers: { Cookie: ownerCookie } })).json();
      assert.equal(statistics.todayDeduplication, index ? 'ip' : 'browser');

      for (const [publicId, cookie] of [['owner-user', ownerCookie], ['owner-page', ownerCookie], ['other-page', otherCookie], ['yangyu', currentAdminCookie]]) {
        const response = await visit(publicId, '198.51.100.201', cookie);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('set-cookie'), null, 'An excluded owner must not receive a visitor identity');
        assert.deepEqual(await response.json(), { today: 0 });
      }
      assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits WHERE visit_date=?').get(date).count, 0);
      assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visit_totals WHERE visit_date=?').get(date).count, 0);

      assert.deepEqual(await (await visit('owner-page', '198.51.100.202')).json(), { today: 1 });
      const visitsBeforeOwner = catalog.prepare('SELECT * FROM daily_visits ORDER BY visit_date,visitor_hash,storage_id').all();
      const totalsBeforeOwner = catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all();
      for (const publicId of ['owner-user', 'owner-page']) {
        const response = await visit(publicId, '198.51.100.203', ownerCookie + '; yangyu_visitor=invalid');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(await response.json(), { today: 1 }, 'Owners see the saved total without recording another visit');
      }
      assert.deepEqual(catalog.prepare('SELECT * FROM daily_visits ORDER BY visit_date,visitor_hash,storage_id').all(), visitsBeforeOwner);
      assert.deepEqual(catalog.prepare('SELECT * FROM daily_visit_totals ORDER BY visit_date,scope_id').all(), totalsBeforeOwner);

      assert.deepEqual(await (await visit('owner-page', '198.51.100.204', otherCookie)).json(), { today: 2 });
      assert.deepEqual(await (await visit('owner-page', '198.51.100.205', currentAdminCookie)).json(), { today: 3 });
      assert.deepEqual(await (await visit('other-page', '198.51.100.206', ownerCookie)).json(), { today: 1 }, 'A matching login name does not make this the session owner’s homepage');
      assert.deepEqual(await (await visit('other-page', '198.51.100.207', currentAdminCookie)).json(), { today: 2 });
      assert.deepEqual(await (await visit('other-page', '198.51.100.208', otherCookie)).json(), { today: 2 });
      assert.deepEqual(await (await visit('yangyu', '198.51.100.208', currentAdminCookie)).json(), { today: 0 });
      const forgedSession = await visit('owner-page', '198.51.100.209', 'yangyu_admin=' + randomBytes(32).toString('hex'));
      assert.equal(forgedSession.status, 200);
      assert.deepEqual(await forgedSession.json(), { today: 4 });

      const tokenHash = createHash('sha256').update(ownerCookie.slice('yangyu_admin='.length)).digest('hex');
      assert.equal(catalog.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(now - 1, tokenHash).changes, 1);
      const expiredSession = await visit('owner-page', '198.51.100.210', ownerCookie);
      assert.equal(expiredSession.status, 200);
      assert.deepEqual(await expiredSession.json(), { today: 5 });
      for (const response of [forgedSession, expiredSession]) {
        if (index) assert.equal(response.headers.get('set-cookie'), null);
        else assert.match(response.headers.get('set-cookie'), /^yangyu_visitor=/);
      }
      assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visits WHERE visit_date=?').get(date).count, 7);
      assert.equal(catalog.prepare("SELECT visitors FROM daily_visit_totals WHERE visit_date=? AND scope_id=''").get(date).visitors, 7);
      assert.equal(catalog.prepare('SELECT visitors FROM daily_visit_totals WHERE visit_date=? AND scope_id=?').get(date, originalStorageId).visitors, 5);
      assert.equal(catalog.prepare('SELECT visitors FROM daily_visit_totals WHERE visit_date=? AND scope_id=(SELECT storage_id FROM users WHERE id=?)').get(date, other.account.id).visitors, 2);
      assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM daily_visit_totals WHERE visit_date=? AND scope_id=(SELECT storage_id FROM users WHERE id=1)').get(date).count, 0);
    }
  } finally {
    catalog?.close();
    await stopServer(server);
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-visits-owner-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

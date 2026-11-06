import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const day = 86400000;
const gib = 1024 ** 3;

test('Subscription codes activate exact fixed periods, replace quotas and consume atomically for registration or renewal', { timeout: 45000 }, async () => {
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-subscriptions-test-'));
  const origin = 'http://127.0.0.1:18130';
  const password = randomBytes(18).toString('base64url');
  const initialTime = Date.parse('2026-11-07T15:59:59Z');
  const clock = resolve(data, 'clock.txt');
  const preload = resolve(data, 'clock.mjs');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18130',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const headers = cookie => ({ Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' });
  const login = async username => {
    const response = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username, password }) });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const register = (username, code) => request('/register', {
    method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams({ username, password, passwordConfirmation: password, displayName: username, invitation: code }),
  });
  const subscription = async cookie => {
    const response = await request('/api/profile/subscription', { headers: headers(cookie) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const exchange = (cookie, code, preview = false) => request('/api/profile/subscription' + (preview ? '/preview' : ''), {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ code }),
  });
  let server, catalog, gallery;
  const start = async () => {
    server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error('Subscription test server exited (' + code + '): ' + errors)));
    });
  };
  const stop = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
  };
  try {
    const setup = spawn(process.execPath, ['app/setup-admin.mjs'], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    setup.stdin.end(JSON.stringify({ username: 'admin', password }));
    assert.equal((await once(setup, 'exit'))[0], 0);
    await writeFile(clock, String(initialTime));
    await writeFile(preload, "import {readFileSync} from 'node:fs'; Date.now=()=>Number(readFileSync(" + JSON.stringify(clock) + ", 'utf8'));\n");
    await start();
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    let adminCookie = await login('admin');
    const generate = async (planId, count = 1, days = 0) => {
      const response = await request('/api/platform/invitations', {
        method: 'POST', headers: headers(adminCookie), body: JSON.stringify({ planId, count, days, quotaBytes: 1, note: 'Subscription test' }),
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    assert.equal((await request('/api/profile/subscription')).status, 401);
    assert.equal((await subscription(adminCookie)).subscription.permanent, true);
    const catalogPlans = (await (await request('/api/platform/invitations', { headers: headers(adminCookie) })).json()).plans;
    assert.deepEqual(catalogPlans.map(plan => [plan.id, plan.priceCents, plan.days, plan.quotaBytes]), [
      ['monthly', 800, 30, 5 * gib], ['quarterly', 2000, 90, 10 * gib], ['yearly', 8800, 365, 20 * gib],
    ]);
    const monthly = await generate('monthly', 2, 1);
    const yearly = await generate('yearly', 2);
    assert.equal((await exchange(adminCookie, yearly.codes[0])).status, 409);
    assert.equal((await exchange(adminCookie, yearly.codes[0], true)).status, 409);
    assert.equal((await register('paid-user', monthly.codes[0])).status, 303);
    assert.equal((await register('duplicate-code', monthly.codes[0])).status, 400);
    let paidCookie = await login('paid-user');
    let paid = await subscription(paidCookie);
    assert.equal(paid.subscription.expiresAt, initialTime + 30 * day);
    assert.equal(paid.subscription.quotaBytes, 5 * gib, 'Caller quota overrides cannot alter paid plan entitlements');
    assert.equal(paid.subscription.planId, 'monthly');
    const account = catalog.prepare("SELECT * FROM users WHERE login_id='paid-user'").get();
    const originalStorageId = account.storage_id;
    const originalGallery = resolve(data, 'photographers', originalStorageId, 'gallery.sqlite');
    gallery = new DatabaseSync(originalGallery);
    const paidCode = catalog.prepare('SELECT * FROM invitations WHERE token_hash=?').get(createHash('sha256').update(monthly.codes[0]).digest('hex'));
    assert.equal(paidCode.expires_at, initialTime + day, 'Code redemption deadline is separate from the 30-day subscription');
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM subscription_redemptions WHERE invitation_id=?').get(paidCode.id).count, 1);

    const preview = await exchange(paidCookie, yearly.codes[0], true);
    assert.equal(preview.status, 200);
    const proposed = await preview.json();
    assert.equal(proposed.plan.days, 365);
    assert.equal(proposed.plan.quotaBytes, 20 * gib);
    assert.equal(proposed.nextExpiresAt, initialTime + 395 * day);
    assert.equal((await subscription(paidCookie)).subscription.expiresAt, initialTime + 30 * day, 'Preview must not consume or extend');
    assert.equal((await exchange(paidCookie, yearly.codes[0])).status, 200);
    paid = await subscription(paidCookie);
    assert.equal(paid.subscription.expiresAt, initialTime + 395 * day);
    assert.equal(paid.subscription.quotaBytes, 20 * gib);
    assert.equal((await exchange(paidCookie, yearly.codes[0])).status, 409);

    const photoId = randomUUID();
    gallery.prepare("INSERT INTO photos (id,series,title,alt,src,image_key,photographer,is_sample,sort_order,created_at) VALUES (?,'scene','Preserved','Preserved','/assets/scene-01.jpg','photos/preserved.jpg','Owner',0,0,?)").run(photoId, new Date(initialTime).toISOString());
    gallery.prepare('INSERT INTO object_sizes VALUES (?,?)').run(photoId, 6 * gib);
    assert.equal((await exchange(paidCookie, monthly.codes[1], true)).status, 200);
    assert.equal((await exchange(paidCookie, monthly.codes[1])).status, 200);
    paid = await subscription(paidCookie);
    assert.equal(paid.subscription.expiresAt, initialTime + 425 * day);
    assert.equal(paid.subscription.quotaBytes, 5 * gib, 'Cross-plan renewal replaces the quota immediately without accumulating');
    assert.equal(paid.usage.storageBytes, 6 * gib);
    assert.equal(paid.usage.availableBytes, 0);
    assert.equal((await request('/api/admin/uploads', { method: 'POST', headers: headers(paidCookie), body: JSON.stringify({ size: 1 }) })).status, 413);
    assert.equal(gallery.prepare('SELECT id FROM photos WHERE id=?').get(photoId).id, photoId);
    assert.equal(catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(account.id).storage_id, originalStorageId);

    const legacy = await request('/api/platform/invitations', { method: 'POST', headers: headers(adminCookie), body: JSON.stringify({ count: 2, days: 0, quotaBytes: 7 * gib, note: 'Legacy permanent account' }) });
    assert.equal(legacy.status, 201);
    const legacyCodes = (await legacy.json()).codes;
    assert.equal((await register('legacy-user', legacyCodes[0])).status, 303);
    const legacyCookie = await login('legacy-user');
    assert.equal((await subscription(legacyCookie)).subscription.permanent, true);
    assert.equal((await exchange(paidCookie, legacyCodes[1])).status, 409, 'Legacy registration codes cannot renew subscriptions');
    const quarter = await generate('quarterly');
    const race = await Promise.all([exchange(paidCookie, quarter.codes[0]), exchange(legacyCookie, quarter.codes[0])]);
    assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
    const quarterId = catalog.prepare('SELECT id FROM invitations WHERE token_hash=?').get(createHash('sha256').update(quarter.codes[0]).digest('hex')).id;
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM subscription_redemptions WHERE invitation_id=?').get(quarterId).count, 1);
    const winner = await race.find(response => response.status === 200).json();
    assert.equal(winner.subscription.planId, 'quarterly');
    assert.equal(winner.subscription.quotaBytes, 10 * gib);

    const subscriptionBeforeFailure = catalog.prepare('SELECT subscription_plan,subscription_expires_at,quota_bytes FROM users WHERE id=?').get(account.id);
    catalog.exec("CREATE TRIGGER fail_subscription_ledger BEFORE INSERT ON subscription_redemptions BEGIN SELECT RAISE(ABORT,'Test ledger failure'); END;");
    assert.equal((await exchange(paidCookie, yearly.codes[1])).status, 503);
    assert.deepEqual(catalog.prepare('SELECT subscription_plan,subscription_expires_at,quota_bytes FROM users WHERE id=?').get(account.id), subscriptionBeforeFailure);
    const unused = catalog.prepare('SELECT used_at FROM invitations WHERE token_hash=?').get(createHash('sha256').update(yearly.codes[1]).digest('hex'));
    assert.equal(unused.used_at, null);
    catalog.exec('DROP TRIGGER fail_subscription_ledger');
    assert.equal((await exchange(paidCookie, yearly.codes[1])).status, 200);

    const unusable = await generate('monthly', 2, 1);
    assert.equal((await request('/api/platform/invitations', { method: 'DELETE', headers: headers(adminCookie), body: JSON.stringify({ id: unusable.invitationIds[0] }) })).status, 200);
    assert.equal((await exchange(paidCookie, unusable.codes[0], true)).status, 409);
    assert.equal((await exchange(paidCookie, unusable.codes[0])).status, 409);

    const reminder = cookie => request('/api/profile/subscription/reminder', { method: 'POST', headers: headers(cookie) }).then(response => response.json());
    catalog.prepare('UPDATE users SET subscription_expires_at=?,subscription_reminded_on=NULL WHERE id=?').run(initialTime + 7 * day + 1, account.id);
    assert.equal((await reminder(paidCookie)).showReminder, false);
    catalog.prepare('UPDATE users SET subscription_expires_at=? WHERE id=?').run(initialTime + 7 * day, account.id);
    const reminders = await Promise.all([reminder(paidCookie), reminder(paidCookie)]);
    assert.deepEqual(reminders.map(result => result.showReminder).sort(), [false, true]);
    await writeFile(clock, String(initialTime + 2000));
    assert.equal((await reminder(paidCookie)).showReminder, true, 'A new Beijing date permits exactly one new reminder');
    await stop(); await start();
    assert.equal((await reminder(paidCookie)).showReminder, false, 'Reminder claim persists across restart');
    await writeFile(clock, String(initialTime + 8 * day));
    paidCookie = await login('paid-user'); adminCookie = await login('admin');
    assert.equal((await subscription(paidCookie)).subscription.expired, true);
    assert.equal((await exchange(paidCookie, unusable.codes[1])).status, 409, 'Expired redemption deadlines cannot grant a subscription');
    assert.equal((await reminder(paidCookie)).showReminder, false);
    assert.equal((await request('/dashboard/subscription', { headers: headers(paidCookie) })).status, 200);
    assert.equal((await request('/api/admin/uploads', { method: 'POST', headers: headers(paidCookie), body: JSON.stringify({ size: 1 }) })).status, 403);
    const renewedQuarter = await generate('quarterly');
    assert.equal((await exchange(paidCookie, renewedQuarter.codes[0])).status, 200);
    paid = await subscription(paidCookie);
    assert.equal(paid.subscription.expiresAt, initialTime + 98 * day, 'An expired subscription restarts from now');
    assert.equal(paid.subscription.quotaBytes, 10 * gib);
    assert.equal(paid.subscription.expired, false);
    assert.equal(catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(account.id).storage_id, originalStorageId);
    assert.equal(gallery.prepare('SELECT COUNT(*) AS count FROM photos WHERE id=?').get(photoId).count, 1);
    assert.equal((await subscription(adminCookie)).subscription.permanent, true);
  } finally {
    gallery?.close(); catalog?.close(); await stop();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-subscriptions-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

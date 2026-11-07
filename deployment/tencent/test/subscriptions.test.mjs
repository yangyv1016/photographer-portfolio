import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
    const generate = async (planId, count = 1, days = 0, rights = {}) => {
      const response = await request('/api/platform/invitations', {
        method: 'POST', headers: headers(adminCookie), body: JSON.stringify({ planId, count, days, note: 'Subscription test', ...rights }),
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
    assert.equal(paid.subscription.quotaBytes, 5 * gib, 'Omitted custom rights retain the selected plan defaults');
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
    assert.equal(proposed.plan.permanent, false);
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
    assert.equal((await exchange(paidCookie, legacyCodes[1], true)).status, 409);
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

    const invitationsBefore = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    for (const invalid of [
      { durationDays: 0 }, { durationDays: -1 }, { durationDays: 1.5 }, { durationDays: '45' }, { durationDays: null },
      { durationDays: Number.MAX_SAFE_INTEGER }, { durationDays: 100000000 },
      { quotaBytes: 0 }, { quotaBytes: -1 }, { quotaBytes: 1.5 }, { quotaBytes: '1024' }, { quotaBytes: Number.MAX_SAFE_INTEGER + 1 },
      { planId: undefined, durationDays: 45, quotaBytes: gib },
    ]) {
      assert.equal((await request('/api/platform/invitations', {
        method: 'POST', headers: headers(adminCookie),
        body: JSON.stringify({ planId: 'monthly', count: 1, days: 0, note: 'Invalid custom rights', ...invalid }),
      })).status, 400);
    }
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, invitationsBefore);
    const customTime = initialTime + 8 * day;
    const daysOnly = await generate('monthly', 1, 0, { durationDays: 3660 });
    assert.equal(daysOnly.plan.days, 3660); assert.equal(daysOnly.plan.quotaBytes, 5 * gib);
    const quotaOnly = await generate('quarterly', 1, 0, { quotaBytes: 13 * gib });
    assert.equal(quotaOnly.plan.days, 90); assert.equal(quotaOnly.plan.quotaBytes, 13 * gib);
    const customMonthly = await generate('monthly', 2, 2, { durationDays: 45, quotaBytes: 12 * gib });
    assert.equal(customMonthly.plan.permanent, false);
    assert.equal(customMonthly.plan.days, 45); assert.equal(customMonthly.plan.quotaBytes, 12 * gib);
    const customList = await (await request('/api/platform/invitations', { headers: headers(adminCookie) })).json();
    const customListing = customList.invitations.find(invitation => invitation.id === customMonthly.invitationIds[0]);
    assert.equal(customListing.durationDays, 45); assert.equal(customListing.quotaBytes, 12 * gib);
    assert.equal(customListing.expiresAt, customTime + 2 * day);
    assert.deepEqual(customList.plans, catalogPlans, 'Issuing custom rights must not mutate the shared plan catalog');
    assert.equal((await register('custom-user', customMonthly.codes[0])).status, 303);
    const customCookie = await login('custom-user');
    let customSubscription = await subscription(customCookie);
    assert.equal(customSubscription.subscription.expiresAt, customTime + 45 * day);
    assert.equal(customSubscription.subscription.quotaBytes, 12 * gib);
    const customQuarter = await generate('quarterly', 1, 0, { durationDays: 13, quotaBytes: 14 * gib });
    const customPreview = await exchange(customCookie, customQuarter.codes[0], true);
    assert.equal(customPreview.status, 200);
    const previewRights = await customPreview.json();
    assert.equal(previewRights.plan.days, 13); assert.equal(previewRights.plan.quotaBytes, 14 * gib);
    assert.equal(previewRights.nextExpiresAt, customTime + 58 * day);
    assert.equal((await exchange(customCookie, customQuarter.codes[0])).status, 200);
    customSubscription = await subscription(customCookie);
    assert.equal(customSubscription.subscription.expiresAt, customTime + 58 * day);
    assert.equal(customSubscription.subscription.quotaBytes, 14 * gib);
    const customAccount = catalog.prepare("SELECT * FROM users WHERE login_id='custom-user'").get();
    const customRedemption = catalog.prepare('SELECT * FROM subscription_redemptions WHERE invitation_id=?').get(customQuarter.invitationIds[0]);
    assert.equal(customRedemption.duration_days, 13); assert.equal(customRedemption.quota_bytes, 14 * gib);
    assert.equal((await request('/api/profile/listing', { method: 'PATCH', headers: headers(customCookie), body: JSON.stringify({ listed: false }) })).status, 200);
    catalog.prepare('UPDATE users SET subscription_reminded_on=? WHERE id=?').run('2026-11-15', customAccount.id);
    const beforeConfiguration = catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id);
    const beforeSessions = catalog.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash').all(customAccount.id);
    const customGalleryPath = resolve(data, 'photographers', customAccount.storage_id, 'gallery.sqlite');
    const beforeGallery = await stat(customGalleryPath);
    const configure = (cookie, fields) => request('/api/platform/accounts', { method: 'PATCH', headers: headers(cookie), body: JSON.stringify(fields) });
    const configuration = { id: customAccount.id, action: 'configure', quotaBytes: 15 * gib, subscriptionPlan: 'yearly', subscriptionExpiresAt: customTime + 6 * day };
    assert.equal((await request('/api/platform/accounts', { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(configuration) })).status, 401);
    assert.equal((await configure(customCookie, configuration)).status, 403);
    assert.equal((await request('/api/platform/accounts', { method: 'PATCH', headers: { ...headers(adminCookie), Origin: 'https://attacker.test' }, body: JSON.stringify(configuration) })).status, 403);
    for (const invalid of [
      { quotaBytes: undefined }, { quotaBytes: 0 }, { quotaBytes: -1 }, { quotaBytes: 1.5 },
      { subscriptionPlan: undefined }, { subscriptionPlan: 'unknown' }, { subscriptionPlan: null },
      { subscriptionExpiresAt: undefined }, { subscriptionExpiresAt: null }, { subscriptionExpiresAt: 'tomorrow' },
      { subscriptionExpiresAt: customTime + 0.5 }, { subscriptionExpiresAt: 8640000000000001 }, { subscriptionExpiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) assert.equal((await configure(adminCookie, { ...configuration, ...invalid })).status, 400);
    assert.deepEqual(catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id), beforeConfiguration);
    assert.equal((await configure(adminCookie, configuration)).status, 200);
    assert.deepEqual({ ...catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id) }, {
      ...beforeConfiguration, quota_bytes: 15 * gib, subscription_plan: 'yearly', subscription_expires_at: customTime + 6 * day, subscription_reminded_on: null,
    });
    assert.deepEqual(catalog.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash').all(customAccount.id), beforeSessions);
    assert.equal((await stat(customGalleryPath)).ino, beforeGallery.ino);
    const configuredAccounts = await (await request('/api/platform/accounts', { headers: headers(adminCookie) })).json();
    assert.deepEqual(configuredAccounts.plans, catalogPlans);
    assert.equal(configuredAccounts.accounts.find(item => item.id === customAccount.id).listed, false);
    assert.equal((await request('/custom-user')).status, 200);
    assert.ok(!(await (await request('/')).text()).includes('href="/custom-user"'));
    assert.equal((await reminder(customCookie)).showReminder, true, 'Changing subscription settings permits a new expiry reminder');
    const remindedOn = catalog.prepare('SELECT subscription_reminded_on FROM users WHERE id=?').get(customAccount.id).subscription_reminded_on;
    assert.equal((await configure(adminCookie, { ...configuration, quotaBytes: 16 * gib })).status, 200);
    assert.equal(catalog.prepare('SELECT subscription_reminded_on FROM users WHERE id=?').get(customAccount.id).subscription_reminded_on, remindedOn);
    assert.equal((await reminder(customCookie)).showReminder, false, 'Changing only capacity must preserve the reminder claim');
    assert.equal((await configure(adminCookie, { ...configuration, subscriptionPlan: 'monthly' })).status, 200);
    assert.equal(catalog.prepare('SELECT subscription_reminded_on FROM users WHERE id=?').get(customAccount.id).subscription_reminded_on, null);
    assert.equal((await reminder(customCookie)).showReminder, true);
    assert.equal((await configure(adminCookie, { ...configuration, subscriptionExpiresAt: customTime - 1 })).status, 200);
    assert.equal((await subscription(customCookie)).subscription.expired, true);
    assert.equal((await request('/custom-user')).status, 403);
    assert.equal((await request('/api/session', { headers: headers(customCookie) })).status, 200, 'Configuration must not invalidate existing sessions');
    const permanentConfiguration = { ...configuration, quotaBytes: 17 * gib, subscriptionPlan: null, subscriptionExpiresAt: null };
    assert.equal((await configure(adminCookie, permanentConfiguration)).status, 200);
    customSubscription = await subscription(customCookie);
    assert.equal(customSubscription.subscription.permanent, true);
    assert.equal(customSubscription.subscription.expiresAt, null); assert.equal(customSubscription.subscription.planId, null);
    assert.equal((await request('/custom-user')).status, 200);
    assert.equal((await configure(adminCookie, { ...configuration, subscriptionExpiresAt: 8640000000000000 })).status, 200);
    assert.equal((await exchange(customCookie, customMonthly.codes[1], true)).status, 409);
    assert.equal((await exchange(customCookie, customMonthly.codes[1])).status, 409);
    assert.equal(catalog.prepare('SELECT used_at FROM invitations WHERE id=?').get(customMonthly.invitationIds[1]).used_at, null);
    assert.equal(catalog.prepare('SELECT subscription_expires_at FROM users WHERE id=?').get(customAccount.id).subscription_expires_at, 8640000000000000);
    assert.equal((await configure(adminCookie, permanentConfiguration)).status, 200);
    assert.equal(catalog.prepare('SELECT listed FROM users WHERE id=?').get(customAccount.id).listed, 0);
    assert.equal(catalog.prepare('SELECT storage_id FROM users WHERE id=?').get(customAccount.id).storage_id, customAccount.storage_id);
    const administrator = (await (await request('/api/session', { headers: headers(adminCookie) })).json()).account;
    const beforeAdministrator = catalog.prepare('SELECT * FROM users WHERE id=?').get(administrator.id);
    assert.equal((await configure(adminCookie, { ...configuration, id: administrator.id })).status, 409);
    assert.deepEqual(catalog.prepare('SELECT * FROM users WHERE id=?').get(administrator.id), beforeAdministrator);
    assert.equal((await configure(adminCookie, { ...permanentConfiguration, id: administrator.id, quotaBytes: 9 * gib })).status, 200);
    assert.deepEqual({ ...catalog.prepare('SELECT * FROM users WHERE id=?').get(administrator.id) }, { ...beforeAdministrator, quota_bytes: 9 * gib });

    const oldRedemptions = catalog.prepare('SELECT * FROM subscription_redemptions ORDER BY invitation_id').all();
    assert.ok(oldRedemptions.length > 0);
    assert.ok(oldRedemptions.every(row => row.plan_id !== null && row.duration_days > 0 && row.expires_at !== null));
    const oldUsers = catalog.prepare('SELECT * FROM users ORDER BY id').all();
    const oldInvitations = catalog.prepare('SELECT * FROM invitations ORDER BY id').all().map(({ grants_permanent, ...invitation }) => invitation);
    await stop();
    catalog.exec(`CREATE TABLE subscription_redemptions_legacy (
      invitation_id TEXT PRIMARY KEY REFERENCES invitations(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      plan_id TEXT NOT NULL,
      duration_days INTEGER NOT NULL CHECK (duration_days > 0),
      previous_plan TEXT,
      previous_expires_at INTEGER,
      expires_at INTEGER NOT NULL,
      previous_quota_bytes INTEGER NOT NULL,
      quota_bytes INTEGER NOT NULL,
      redeemed_at TEXT NOT NULL
    );
    INSERT INTO subscription_redemptions_legacy SELECT * FROM subscription_redemptions;
    DROP TABLE subscription_redemptions;
    ALTER TABLE subscription_redemptions_legacy RENAME TO subscription_redemptions;
    CREATE INDEX subscription_redemptions_user ON subscription_redemptions(user_id,redeemed_at);
    ALTER TABLE invitations DROP COLUMN grants_permanent;
    DELETE FROM platform_migrations WHERE name='permanent-subscription-codes';`);
    await start();
    assert.deepEqual(catalog.prepare('SELECT * FROM subscription_redemptions ORDER BY invitation_id').all(), oldRedemptions);
    assert.deepEqual(catalog.prepare('SELECT * FROM users ORDER BY id').all(), oldUsers);
    assert.deepEqual(catalog.prepare('SELECT * FROM invitations ORDER BY id').all().map(({ grants_permanent, ...invitation }) => invitation), oldInvitations);
    assert.ok(catalog.prepare('SELECT grants_permanent FROM invitations').all().every(row => row.grants_permanent === 0));
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM platform_migrations WHERE name='permanent-subscription-codes'").get().count, 1);
    assert.ok(catalog.prepare("PRAGMA index_list('subscription_redemptions')").all().some(index => index.name === 'subscription_redemptions_user'));
    assert.deepEqual(catalog.prepare('PRAGMA foreign_key_check').all(), []);
    const insertMixedRedemption = catalog.prepare(`INSERT INTO subscription_redemptions
      (invitation_id,user_id,plan_id,duration_days,expires_at,previous_quota_bytes,quota_bytes,redeemed_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const [planId, durationDays, expiresAt] of [[null, 30, customTime + 30 * day], ['monthly', null, customTime + 30 * day], ['monthly', 30, null]]) {
      assert.throws(() => insertMixedRedemption.run(customMonthly.invitationIds[1], customAccount.id, planId, durationDays, expiresAt, gib, gib, new Date(customTime).toISOString()), /CHECK/);
    }
    const permanentCount = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    for (const invalid of [
      { permanent: 'true' }, { permanent: 1 }, { permanent: null }, { planId: 'monthly' }, { durationDays: 30 },
      { quotaBytes: undefined }, { quotaBytes: 0 }, { quotaBytes: -1 }, { quotaBytes: 1.5 },
    ]) assert.equal((await request('/api/platform/invitations', {
      method: 'POST', headers: headers(adminCookie),
      body: JSON.stringify({ count: 5, days: 2, permanent: true, quotaBytes: 19 * gib, note: 'Permanent subscription', ...invalid }),
    })).status, 400);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, permanentCount);
    const permanentResponse = await request('/api/platform/invitations', {
      method: 'POST', headers: headers(adminCookie),
      body: JSON.stringify({ count: 5, days: 2, permanent: true, quotaBytes: 19 * gib, note: 'Permanent subscription' }),
    });
    assert.equal(permanentResponse.status, 201);
    const permanentCodes = await permanentResponse.json();
    assert.deepEqual(permanentCodes.plan, { id: 'permanent', name: '长期有效', days: null, quotaBytes: 19 * gib, permanent: true });
    const permanentInvitations = permanentCodes.codes.map(code => catalog.prepare('SELECT * FROM invitations WHERE token_hash=?').get(createHash('sha256').update(code).digest('hex')));
    assert.equal(permanentInvitations.length, 5);
    for (const invitation of permanentInvitations) {
      assert.equal(invitation.grants_permanent, 1); assert.equal(invitation.subscription_plan, null); assert.equal(invitation.duration_days, null);
      assert.equal(invitation.expires_at, customTime + 2 * day);
    }
    const permanentList = await (await request('/api/platform/invitations', { headers: headers(adminCookie) })).json();
    assert.deepEqual(permanentList.plans, catalogPlans);
    assert.ok(permanentList.invitations.every(invitation => typeof invitation.permanent === 'boolean'));
    assert.equal(permanentList.invitations.find(invitation => invitation.id === permanentInvitations[0].id).permanent, true);
    assert.equal(permanentList.invitations.find(invitation => invitation.id === customMonthly.invitationIds[0]).permanent, false);
    assert.equal((await register('permanent-user', permanentCodes.codes[0])).status, 303);
    const permanentCookie = await login('permanent-user');
    const permanentSubscription = await subscription(permanentCookie);
    assert.equal(permanentSubscription.subscription.permanent, true); assert.equal(permanentSubscription.subscription.expiresAt, null);
    assert.equal(permanentSubscription.subscription.planId, null); assert.equal(permanentSubscription.subscription.quotaBytes, 19 * gib);
    const registrationLedger = catalog.prepare('SELECT * FROM subscription_redemptions WHERE invitation_id=?').get(permanentInvitations[0].id);
    assert.equal(registrationLedger.plan_id, null); assert.equal(registrationLedger.duration_days, null); assert.equal(registrationLedger.expires_at, null);
    assert.equal(registrationLedger.quota_bytes, 19 * gib);
    assert.equal((await exchange(customCookie, permanentCodes.codes[0])).status, 409);
    assert.equal((await register('used-permanent', permanentCodes.codes[0])).status, 400);
    assert.equal((await configure(adminCookie, configuration)).status, 200);
    const beforePermanent = catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id);
    const permanentPreview = await exchange(customCookie, permanentCodes.codes[1], true);
    assert.equal(permanentPreview.status, 200);
    const permanentProposal = await permanentPreview.json();
    assert.deepEqual(permanentProposal.plan, permanentCodes.plan); assert.equal(permanentProposal.nextExpiresAt, null);
    assert.deepEqual(catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id), beforePermanent);
    assert.equal(catalog.prepare('SELECT used_at FROM invitations WHERE id=?').get(permanentInvitations[1].id).used_at, null);
    assert.equal((await exchange(customCookie, permanentCodes.codes[1])).status, 200);
    assert.deepEqual({ ...catalog.prepare('SELECT * FROM users WHERE id=?').get(customAccount.id) }, {
      ...beforePermanent, subscription_plan: null, subscription_expires_at: null, quota_bytes: 19 * gib, subscription_reminded_on: null,
    });
    const exchangeLedger = catalog.prepare('SELECT * FROM subscription_redemptions WHERE invitation_id=?').get(permanentInvitations[1].id);
    assert.equal(exchangeLedger.plan_id, null); assert.equal(exchangeLedger.duration_days, null); assert.equal(exchangeLedger.expires_at, null);
    assert.equal(exchangeLedger.previous_plan, beforePermanent.subscription_plan);
    assert.equal(exchangeLedger.previous_expires_at, beforePermanent.subscription_expires_at);
    assert.deepEqual(catalog.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash').all(customAccount.id), beforeSessions);
    assert.equal((await stat(customGalleryPath)).ino, beforeGallery.ino);
    assert.equal((await exchange(customCookie, permanentCodes.codes[1])).status, 409);
    assert.equal((await register('exchanged-permanent', permanentCodes.codes[1])).status, 400);
    const permanentRace = await Promise.all([register('permanent-race', permanentCodes.codes[2]), exchange(customCookie, permanentCodes.codes[2])]);
    assert.equal(permanentRace.filter(response => [200, 303].includes(response.status)).length, 1);
    assert.equal(permanentRace.filter(response => [400, 409].includes(response.status)).length, 1);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM subscription_redemptions WHERE invitation_id=?').get(permanentInvitations[2].id).count, 1);
    assert.equal((await request('/api/platform/invitations', { method: 'DELETE', headers: headers(adminCookie), body: JSON.stringify({ id: permanentInvitations[3].id }) })).status, 200);
    catalog.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(customTime, permanentInvitations[4].id);
    for (const index of [3, 4]) {
      assert.equal((await exchange(customCookie, permanentCodes.codes[index], true)).status, 409);
      assert.equal((await exchange(customCookie, permanentCodes.codes[index])).status, 409);
      assert.equal((await register('unavailable-permanent-' + index, permanentCodes.codes[index])).status, 400);
      assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM subscription_redemptions WHERE invitation_id=?').get(permanentInvitations[index].id).count, 0);
    }
    assert.equal((await exchange(customCookie, legacyCodes[1], true)).status, 409);
    assert.equal((await exchange(customCookie, legacyCodes[1])).status, 409);
    const redemptionsBeforeRestart = catalog.prepare('SELECT * FROM subscription_redemptions ORDER BY invitation_id').all();
    await stop(); await start();
    assert.deepEqual(catalog.prepare('SELECT * FROM subscription_redemptions ORDER BY invitation_id').all(), redemptionsBeforeRestart);
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM platform_migrations WHERE name='permanent-subscription-codes'").get().count, 1);
    assert.deepEqual(catalog.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(catalog.prepare('SELECT grants_permanent FROM invitations WHERE id=?').get(permanentInvitations[0].id).grants_permanent, 1);
    assert.equal((await subscription(permanentCookie)).subscription.expiresAt, null);
  } finally {
    gallery?.close(); catalog?.close(); await stop();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-subscriptions-test-'));
    await rm(data, { recursive: true, force: true });
  }
});

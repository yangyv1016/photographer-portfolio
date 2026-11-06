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

test('Afdian test notifications persist bounded unverified receipts without issuing or consuming subscription codes', { timeout: 45000 }, async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-afdian-webhook-'));
  const origin = 'http://127.0.0.1:18134';
  const password = randomBytes(18).toString('base64url');
  const clock = resolve(data, 'clock.txt');
  const preload = resolve(data, 'clock.mjs');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18134',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
  };
  let now = Date.parse('2026-11-07T04:00:00Z');
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const notify = (orderNo, ip = '198.51.100.10', order = {}) => request('/api/integrations/afdian/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ ec: 200, em: 'ok', data: { type: 'order', order: {
      out_trade_no: orderNo, user_id: 'buyer-test', plan_id: 'plan-test', month: 1, total_amount: '8.00', status: 2,
      address_phone: 'never-store-this-phone', address_address: 'never-store-this-address', remark: 'never-store-this-remark',
      ...order,
    }, sign: 'never-store-this-signature' } }),
  });
  const nextMinute = async () => { now += 60000; await writeFile(clock, String(now)); };
  let server, catalog;
  const start = async () => {
    server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'app/server.mjs'], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error('Webhook test server exited (' + code + '): ' + errors)));
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
    await writeFile(clock, String(now));
    await writeFile(preload, "import {readFileSync} from 'node:fs'; Date.now=()=>Number(readFileSync(" + JSON.stringify(clock) + ", 'utf8'));\n");
    await start();
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    const login = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(login.status, 303);
    const adminCookie = login.headers.get('set-cookie').split(';')[0];
    const adminHeaders = { Cookie: adminCookie, Origin: origin, 'Content-Type': 'application/json' };
    const generated = await request('/api/platform/invitations', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ planId: 'monthly', count: 2, days: 0, note: 'Webhook isolation test' }),
    });
    assert.equal(generated.status, 201);
    const { codes } = await generated.json();
    const registration = await request('/register', {
      method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'webhook-member', displayName: 'Member', password, passwordConfirmation: password, invitation: codes[0] }),
    });
    assert.equal(registration.status, 303);
    const memberCookie = registration.headers.get('set-cookie').split(';')[0];
    const before = ['users', 'invitations', 'subscription_redemptions'].map(table => catalog.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all());
    assert.equal((await request('/api/integrations/afdian/webhook')).status, 405);
    assert.equal((await request('/api/platform/afdian/receipts')).status, 401);
    assert.equal((await request('/api/platform/afdian/receipts', { headers: { Cookie: memberCookie } })).status, 403);

    const first = await notify('official-test-order');
    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await first.json(), { ec: 200, em: '通知已收件，尚未核验订单或自动发码。', mode: 'test', auto_fulfillment: false });
    const firstReceipt = catalog.prepare('SELECT * FROM afdian_webhook_receipts').get();
    assert.equal(firstReceipt.processing_state, 'pending_verification');
    assert.equal(firstReceipt.delivery_count, 1);
    assert.equal(firstReceipt.total_amount, '8.00');
    assert.ok(!JSON.stringify(firstReceipt).includes('never-store-this'));
    await nextMinute();
    assert.equal((await notify('official-test-order', '198.51.100.10', { total_amount: '88.00', month: 12 })).status, 200);
    const repeated = catalog.prepare('SELECT * FROM afdian_webhook_receipts').get();
    assert.equal(repeated.delivery_count, 2);
    assert.equal(repeated.first_received_at, firstReceipt.first_received_at);
    assert.notEqual(repeated.last_received_at, firstReceipt.last_received_at);
    assert.equal(repeated.total_amount, '8.00', 'Retries cannot replace the first unverified order fields');
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count, 1);
    const listing = await request('/api/platform/afdian/receipts', { headers: adminHeaders });
    assert.equal(listing.status, 200);
    const listed = await listing.json();
    assert.equal(listed.total, 1);
    assert.equal(listed.receipts[0].outTradeNo, 'official-test-order');
    assert.equal(listed.receipts[0].deliveryCount, 2);
    assert.equal(listed.autoFulfillment, false);
    assert.equal((await request('/api/platform/afdian/receipts?page=0', { headers: adminHeaders })).status, 400);

    const invalidJson = await request('/api/integrations/afdian/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.20' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).ec, 400);
    for (const fields of [{ out_trade_no: '' }, { out_trade_no: 'x'.repeat(101) }, { total_amount: '8e5' }, { month: '1' }, { status: -1 }, { user_id: 'x'.repeat(129) }]) {
      assert.equal((await notify('invalid-order', '198.51.100.20', fields)).status, 400);
    }
    assert.equal((await request('/api/integrations/afdian/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.20' }, body: JSON.stringify({ data: { type: 'unknown', order: { out_trade_no: 'invalid-type' } } }) })).status, 400);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count, 1);

    catalog.exec("CREATE TRIGGER reject_test_receipt BEFORE INSERT ON afdian_webhook_receipts BEGIN SELECT RAISE(ABORT, 'Test receipt storage failure'); END;");
    assert.equal((await notify('storage-failure', '198.51.100.21')).status, 503);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count, 1);
    catalog.exec('DROP TRIGGER reject_test_receipt');
    await stop();
    await start();
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM platform_migrations WHERE name='afdian-webhook-receipts'").get().count, 1);
    assert.equal(catalog.prepare('SELECT delivery_count FROM afdian_webhook_receipts').get().delivery_count, 2);

    await nextMinute();
    for (let index = 0; index < 30; index++) assert.equal((await notify('single-source-' + index, '198.51.100.30')).status, 200);
    const throttled = await notify('single-source-overflow', '198.51.100.30');
    assert.equal(throttled.status, 429);
    assert.equal((await throttled.json()).ec, 429);
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM afdian_webhook_receipts WHERE out_trade_no='single-source-overflow'").get().count, 0);
    await nextMinute();
    assert.equal((await notify('single-source-after-reset', '198.51.100.30')).status, 200);
    await nextMinute();
    for (let index = 0; index < 125; index++) {
      const response = await notify('global-source-' + index, '198.51.100.' + (40 + Math.floor(index / 25)));
      assert.equal(response.status, index < 120 ? 200 : 429);
    }
    assert.equal(catalog.prepare("SELECT COUNT(*) AS count FROM afdian_webhook_receipts WHERE out_trade_no LIKE 'global-source-%'").get().count, 120);

    const count = catalog.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count;
    catalog.prepare(`WITH RECURSIVE additions(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM additions WHERE n<?)
      INSERT INTO afdian_webhook_receipts (out_trade_no,processing_state,first_received_at,last_received_at,delivery_count)
      SELECT 'filled-'||n,'pending_verification',?,?,1 FROM additions`).run(5000 - count, new Date(now).toISOString(), new Date(now).toISOString());
    await nextMinute();
    assert.equal((await notify('capacity-overflow', '198.51.100.60')).status, 503);
    assert.equal((await notify('official-test-order', '198.51.100.60')).status, 200);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count, 5000);
    assert.equal(catalog.prepare("SELECT delivery_count FROM afdian_webhook_receipts WHERE out_trade_no='official-test-order'").get().delivery_count, 3);
    assert.deepEqual(['users', 'invitations', 'subscription_redemptions'].map(table => catalog.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()), before);
  } finally {
    catalog?.close();
    await stop();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-afdian-webhook-'));
    await rm(data, { recursive: true, force: true });
  }
});

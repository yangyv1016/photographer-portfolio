import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Self-service delivery verifies merchant orders, privately sends one encrypted persisted code and safely retries', { timeout: 60000 }, async () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(resolve(tmpdir(), 'yangyu-afdian-delivery-'));
  const origin = 'http://127.0.0.1:18136';
  const password = randomBytes(18).toString('base64url');
  const merchantId = 'a'.repeat(32);
  const token = 'test-only-afdian-token';
  const planIds = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
  const goodsPlanId = '5'.repeat(32);
  const [smallSku, largeSku] = ['sku-a', 'sku-b'];
  const gib = 1024 ** 3;
  const addonCatalog = [
    { planId: goodsPlanId, skuId: smallSku, priceCents: 2500, addOnBytes: 5 * gib },
    { planId: goodsPlanId, skuId: largeSku, priceCents: 4500, addOnBytes: 10 * gib },
  ];
  const clock = resolve(data, 'clock.txt');
  const providerData = resolve(data, 'provider.json');
  const providerLog = resolve(data, 'provider.log');
  const preload = resolve(data, 'provider.mjs');
  const environment = {
    ...process.env, YANGYU_ROOT: directory, DATA_DIRECTORY: data, PUBLIC_ORIGIN: origin, PORT: '18136',
    STORAGE_BACKEND: 'local', COS_BUCKET: 'test-1250000000', COS_REGION: 'ap-chengdu',
    COS_SECRET_ID: 'test-only-id', COS_SECRET_KEY: 'test-only-key',
    AFDIAN_USER_ID: merchantId, AFDIAN_API_TOKEN: token, AFDIAN_DELIVERY_KEY: '4'.repeat(64),
    AFDIAN_MONTHLY_PLAN_ID: planIds[0], AFDIAN_QUARTERLY_PLAN_ID: planIds[1], AFDIAN_YEARLY_PLAN_ID: planIds[2],
    AFDIAN_STORAGE_ADDONS: JSON.stringify(addonCatalog),
  };
  const orders = {};
  let provider = { orders, sendFailure: false, queryFailure: false, malformedQuery: false, historyFailure: false, historyReplies: {} };
  let now = Date.parse('2026-11-07T04:00:00Z');
  const nextMinute = async () => { now += 61000; await writeFile(clock, String(now)); };
  const saveProvider = () => writeFile(providerData, JSON.stringify(provider));
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const claim = (orderNo, options = {}) => request('/api/integrations/afdian/delivery', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10', ...options.headers },
    body: options.body ?? JSON.stringify({ orderNo }),
  });
  const events = async () => (await readFile(providerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const order = (orderNo, planIndex = 0, extra = {}) => {
    const months = [1, 3, 12][planIndex];
    const amount = ['8.00', '20.00', '88.00'][planIndex];
    orders[orderNo] = { out_trade_no: orderNo, user_id: 'buyer-' + orderNo, plan_id: planIds[planIndex], month: months,
      total_amount: amount, status: 2, product_type: 0, redeem_id: '', ...extra };
  };
  const goodsOrder = (orderNo, extra = {}) => order(orderNo, 0, {
    plan_id: goodsPlanId, month: 0, product_type: 1, total_amount: '95.00',
    sku_detail: [{ sku_id: largeSku, count: 1 }, { sku_id: smallSku, count: 2 }], ...extra,
  });
  let server, catalog;
  const start = async (settings = environment) => {
    server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'app/server.mjs'], { cwd: directory, env: settings, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((ready, reject) => {
      server.stdout.once('data', ready);
      server.once('error', reject);
      server.once('exit', code => reject(new Error('Claim server exited (' + code + '): ' + errors)));
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
    await saveProvider();
    await writeFile(providerLog, '');
    await writeFile(preload, `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,appendFileSync} from 'node:fs';
Date.now=()=>Number(readFileSync(${JSON.stringify(clock)},'utf8'));
globalThis.fetch=async(input,options)=>{
 const url=new URL(input);
 assert.equal(url.origin,'https://ifdian.net');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
 const payload=JSON.parse(options.body);assert.equal(payload.user_id,${JSON.stringify(merchantId)});
 assert.equal(payload.ts,Math.floor(Date.now()/1000));
 assert.equal(payload.sign,createHash('md5').update(${JSON.stringify(token)}+'params'+payload.params+'ts'+payload.ts+'user_id'+payload.user_id).digest('hex'));
 const params=JSON.parse(payload.params);const source=JSON.parse(readFileSync(${JSON.stringify(providerData)},'utf8'));
 if(url.pathname==='/api/open/query-order'){
   appendFileSync(${JSON.stringify(providerLog)},JSON.stringify({type:'query',orderNo:params.out_trade_no})+'\\n');
   if(source.queryFailure) return new Response(JSON.stringify({ec:500,em:'do-not-expose-provider-secret'}),{status:200});
   if(source.malformedQuery) return Response.json({ec:200,data:{list:[{status:2}]}});
   const found=source.orders[params.out_trade_no];return Response.json({ec:200,data:{list:found?[found]:[]}});
 }
 if(url.pathname==='/api/open/query-random-reply'){
   appendFileSync(${JSON.stringify(providerLog)},JSON.stringify({type:'history',orderNo:params.out_trade_no})+'\\n');
   if(source.historyFailure) return Response.json({ec:500,em:'do-not-expose-history-secret'});
   const content=source.historyReplies[params.out_trade_no];
   return Response.json({ec:200,data:{list:content===undefined?[]:[{out_trade_no:params.out_trade_no,content}]}});
 }
 assert.equal(url.pathname,'/api/open/send-msg');
 const code=params.content.match(/YY-[A-Za-z0-9_-]+/)[0];
 appendFileSync(${JSON.stringify(providerLog)},JSON.stringify({type:'send',recipient:params.recipient,code,content:params.content})+'\\n');
 await new Promise(resolve=>setTimeout(resolve,80));
 if(source.sendFailure) return Response.json({ec:500,em:'do-not-expose-provider-secret'});
 return Response.json({ec:200,em:'success'});
};\n`);
    await start();
    catalog = new DatabaseSync(resolve(data, 'platform.sqlite'));
    let expectedUsers = catalog.prepare('SELECT * FROM users ORDER BY id').all();
    assert.deepEqual(await (await request('/api/integrations/afdian/delivery/status')).json(), { configured: true });
    assert.equal((await request('/api/integrations/afdian/delivery')).status, 405);
    assert.equal((await claim('irrelevant', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await claim('irrelevant', { body: JSON.stringify({ orderNo: 'irrelevant', recipient: 'attacker' }) })).status, 400);
    assert.equal((await claim('irrelevant', { body: '{' })).status, 400);
    assert.equal((await claim('unknown')).status, 409);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);

    await nextMinute();
    for (const [name, values] of [['unpaid', { status: 0 }], ['wrong-plan', { plan_id: 'f'.repeat(32) }], ['underpaid', { total_amount: '0.01' }], ['gift', { redeem_id: 'gift' }], ['goods', { product_type: 1 }]]) {
      order(name, 0, values); await saveProvider();
      const response = await claim(name); assert.equal(response.status, 409, name);
      assert.ok((await response.json()).error);
    }
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_order_deliveries').get().count, 0);

    await nextMinute();
    order('legacy-random-reply'); provider.historyReplies['legacy-random-reply'] = 'never-return-old-delivery-content'; await saveProvider();
    const historical = await claim('legacy-random-reply');
    assert.equal(historical.status, 409);
    assert.ok(!(await historical.text()).includes('never-return-old-delivery-content'));
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);
    order('history-query-failure'); provider.historyFailure = true; await saveProvider();
    const historyFailure = await claim('history-query-failure');
    assert.equal(historyFailure.status, 502);
    assert.ok(!(await historyFailure.text()).includes('do-not-expose-history-secret'));
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);
    provider.historyFailure = false; await saveProvider();

    await nextMinute();
    order('monthly-order'); await saveProvider();
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => claim('monthly-order')));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 202, 202]);
    for (const response of concurrent) {
      const result = await response.json();
      assert.ok(['sent', 'processing'].includes(result.status));
      assert.ok(!JSON.stringify(result).includes('YY-'));
      assert.ok(!JSON.stringify(result).includes('buyer-'));
    }
    const delivered = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('monthly-order');
    assert.equal(delivered.state, 'sent'); assert.equal(delivered.attempts, 1);
    const monthlyCode = (await events()).find(event => event.type === 'send').code;
    assert.ok(!delivered.encrypted_code.includes(monthlyCode));
    const invitation = catalog.prepare('SELECT * FROM invitations WHERE id=?').get(delivered.invitation_id);
    assert.equal(invitation.token_hash, createHash('sha256').update(monthlyCode).digest('hex'));
    assert.equal(invitation.duration_days, 30); assert.equal(invitation.quota_bytes, 5 * 1024 ** 3);
    assert.equal(invitation.used_at, null);
    assert.equal((await events()).filter(event => event.type === 'send').length, 1);
    assert.equal((await events()).find(event => event.type === 'send').recipient, 'buyer-monthly-order');
    const beforeRepeat = await events();
    assert.equal((await claim('monthly-order')).status, 200);
    assert.deepEqual(await events(), beforeRepeat, 'Sent orders cannot be used to spam the buyer or query private data again');

    await nextMinute();
    order('quarterly-order', 1); order('yearly-order', 2); order('multi-month', 0, { month: 3, total_amount: '24.00' });
    order('broken-period', 1, { month: 4, total_amount: '20.00' }); await saveProvider();
    for (const name of ['quarterly-order', 'yearly-order', 'multi-month']) assert.equal((await claim(name)).status, 200);
    assert.equal((await claim('broken-period')).status, 409);
    const issued = catalog.prepare(`SELECT afdian_order_deliveries.out_trade_no,invitations.duration_days,invitations.quota_bytes
      FROM afdian_order_deliveries JOIN invitations ON invitations.id=afdian_order_deliveries.invitation_id ORDER BY out_trade_no`).all();
    assert.deepEqual(issued.map(item => [item.out_trade_no, item.duration_days, item.quota_bytes]), [
      ['monthly-order', 30, 5 * 1024 ** 3], ['multi-month', 90, 5 * 1024 ** 3],
      ['quarterly-order', 90, 10 * 1024 ** 3], ['yearly-order', 365, 20 * 1024 ** 3],
    ]);
    assert.deepEqual(catalog.prepare('SELECT * FROM users ORDER BY id').all(), expectedUsers);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM subscription_redemptions').get().count, 0);

    await nextMinute();
    order('retry-order'); provider.sendFailure = true; await saveProvider();
    const failed = await claim('retry-order'); assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes('do-not-expose-provider-secret'));
    const failedRow = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('retry-order');
    assert.equal(failedRow.state, 'pending');
    const pendingCount = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    assert.equal((await claim('retry-order')).status, 202);
    await nextMinute();
    provider.sendFailure = false; await saveProvider();
    assert.equal((await claim('retry-order')).status, 200);
    const retryRow = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('retry-order');
    assert.equal(retryRow.invitation_id, failedRow.invitation_id); assert.equal(retryRow.encrypted_code, failedRow.encrypted_code);
    assert.equal(retryRow.attempts, 2); assert.equal(retryRow.state, 'sent');
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, pendingCount);
    const retryMessages = (await events()).filter(event => event.type === 'send' && event.recipient === 'buyer-retry-order');
    assert.equal(retryMessages.length, 2); assert.equal(retryMessages[0].code, retryMessages[1].code);

    await nextMinute();
    order('used-after-failure'); provider.sendFailure = true; await saveProvider();
    assert.equal((await claim('used-after-failure')).status, 502);
    const receivedCode = (await events()).find(event => event.type === 'send' && event.recipient === 'buyer-used-after-failure').code;
    const registered = await request('/register', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({
      username: 'delivered-member', displayName: 'Delivered member', password, passwordConfirmation: password, invitation: receivedCode,
    }) });
    assert.equal(registered.status, 303);
    const memberCookie = registered.headers.get('set-cookie').split(';')[0];
    expectedUsers = catalog.prepare('SELECT * FROM users ORDER BY id').all();
    const usedEvents = await events();
    assert.equal((await claim('used-after-failure')).status, 200);
    assert.deepEqual(await events(), usedEvents, 'A redeemed code must not cause any further order query or message');
    const usedDelivery = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('used-after-failure');
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations WHERE id=? AND used_at IS NOT NULL').get(usedDelivery.invitation_id).count, 1);

    await nextMinute();
    order('revoked-after-failure'); await saveProvider();
    assert.equal((await claim('revoked-after-failure')).status, 502);
    const revokedDelivery = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('revoked-after-failure');
    const administrator = await request('/login', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ username: 'admin', password }) });
    assert.equal(administrator.status, 303);
    const adminCookie = administrator.headers.get('set-cookie').split(';')[0];
    const revoke = await request('/api/platform/invitations', { method: 'DELETE', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: revokedDelivery.invitation_id }) });
    assert.equal(revoke.status, 200);
    const revokedEvents = await events();
    const revokedInvitationCount = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    assert.equal((await claim('revoked-after-failure')).status, 409);
    assert.deepEqual(await events(), revokedEvents, 'Administrator revocation must prevent both resend and replacement');
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, revokedInvitationCount);

    await nextMinute();
    order('expired-after-failure'); await saveProvider();
    assert.equal((await claim('expired-after-failure')).status, 502);
    const expiredDelivery = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('expired-after-failure');
    catalog.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(now, expiredDelivery.invitation_id);
    const expiredEvents = await events();
    assert.equal((await claim('expired-after-failure')).status, 409);
    assert.deepEqual(await events(), expiredEvents, 'An expired code must not be resent or silently replaced');
    provider.sendFailure = false;

    await nextMinute();
    order('atomic-order'); await saveProvider();
    const beforeFailure = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    catalog.exec("CREATE TRIGGER fail_delivery_insert BEFORE INSERT ON afdian_order_deliveries BEGIN SELECT RAISE(ABORT, 'test order ledger failure'); END;");
    assert.equal((await claim('atomic-order')).status, 503);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, beforeFailure);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM afdian_order_deliveries WHERE out_trade_no=?').get('atomic-order').count, 0);
    catalog.exec('DROP TRIGGER fail_delivery_insert');
    assert.equal((await claim('atomic-order')).status, 200);

    await nextMinute();
    provider.queryFailure = true; await saveProvider();
    const badProvider = await claim('unknown-provider-order'); assert.equal(badProvider.status, 502);
    assert.ok(!(await badProvider.text()).includes('do-not-expose-provider-secret'));
    provider.queryFailure = false; provider.malformedQuery = true; await saveProvider();
    assert.equal((await claim('unknown-provider-order')).status, 502);
    provider.malformedQuery = false; await saveProvider();

    await nextMinute();
    for (let index = 0; index < 5; index++) assert.equal((await claim('missing-' + index)).status, 409);
    const limited = await claim('missing-after-limit'); assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    await nextMinute();
    for (let index = 0; index < 15; index++) assert.equal((await claim('global-missing-' + index, { headers: { 'X-Forwarded-For': '198.51.100.' + (index + 30) } })).status, 409);
    assert.equal((await claim('global-over-limit', { headers: { 'X-Forwarded-For': '198.51.100.99' } })).status, 429);

    const oldDeliveries = catalog.prepare('SELECT * FROM afdian_order_deliveries ORDER BY out_trade_no').all();
    assert.ok(oldDeliveries.every(row => row.sku_quantities === null));
    await stop();
    catalog.exec(`ALTER TABLE afdian_order_deliveries DROP COLUMN sku_quantities;
      DELETE FROM platform_migrations WHERE name='afdian-storage-addon-deliveries';`);
    await start();
    assert.deepEqual(catalog.prepare('SELECT * FROM afdian_order_deliveries ORDER BY out_trade_no').all(), oldDeliveries);
    const beforeRestartRetry = await events();
    assert.equal((await claim('monthly-order')).status, 200);
    assert.deepEqual(await events(), beforeRestartRetry);

    const beforeBadGoods = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    const beforeBadGoodsEvents = (await events()).filter(event => event.type !== 'query');
    for (const [name, fields] of [
      ['unknown-goods', { plan_id: 'f'.repeat(32) }],
      ['missing-sku', { sku_detail: undefined }],
      ['empty-sku', { sku_detail: [] }],
      ['duplicate-sku', { sku_detail: [{ sku_id: smallSku, count: 1 }, { sku_id: smallSku, count: 1 }] }],
      ['unknown-sku', { sku_detail: [{ sku_id: 'unmapped', count: 1 }] }],
      ['zero-count', { sku_detail: [{ sku_id: smallSku, count: 0 }] }],
      ['fractional-count', { sku_detail: [{ sku_id: smallSku, count: 1.5 }] }],
      ['unsafe-count', { sku_detail: [{ sku_id: smallSku, count: Number.MAX_SAFE_INTEGER + 1 }] }],
      ['wrong-goods-total', { total_amount: '95.01' }],
      ['goods-bytes-overflow', { total_amount: '50000000.00', sku_detail: [{ sku_id: smallSku, count: 2000000 }] }],
      ['goods-price-overflow', { total_amount: String(BigInt(Number.MAX_SAFE_INTEGER) * 25n), sku_detail: [{ sku_id: smallSku, count: Number.MAX_SAFE_INTEGER }] }],
    ]) {
      await nextMinute();
      goodsOrder(name, fields); await saveProvider();
      assert.equal((await claim(name)).status, 409, name);
    }
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, beforeBadGoods);
    assert.deepEqual((await events()).filter(event => event.type !== 'query'), beforeBadGoodsEvents);
    goodsOrder('goods-historical-reply');
    provider.historyReplies['goods-historical-reply'] = 'already-delivered-storage-code';
    await saveProvider();
    const historicalGoods = await claim('goods-historical-reply');
    assert.equal(historicalGoods.status, 409);
    assert.ok(!(await historicalGoods.text()).includes('already-delivered-storage-code'));
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, beforeBadGoods);

    await nextMinute();
    goodsOrder('goods-order'); await saveProvider();
    const goodsClaims = await Promise.all(Array.from({ length: 3 }, () => claim('goods-order')));
    assert.deepEqual(goodsClaims.map(response => response.status).sort(), [200, 202, 202]);
    for (const response of goodsClaims) {
      const body = await response.text();
      assert.ok(!body.includes('YY-') && !body.includes('buyer-goods-order'));
    }
    const goodsDelivery = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('goods-order');
    assert.equal(goodsDelivery.subscription_plan, 'storage-addon');
    assert.equal(goodsDelivery.order_months, 0);
    assert.equal(goodsDelivery.paid_amount_cents, 9500);
    assert.equal(goodsDelivery.sku_quantities, JSON.stringify([[smallSku, 2], [largeSku, 1]]));
    const goodsInvitation = catalog.prepare('SELECT * FROM invitations WHERE id=?').get(goodsDelivery.invitation_id);
    assert.equal(goodsInvitation.add_on_bytes, 20 * gib);
    assert.equal(goodsInvitation.quota_bytes, 0);
    assert.equal(goodsInvitation.subscription_plan, null);
    assert.equal(goodsInvitation.expires_at, null);
    const goodsMessages = (await events()).filter(event => event.type === 'send' && event.recipient === 'buyer-goods-order');
    assert.equal(goodsMessages.length, 1);
    const goodsMessage = goodsMessages[0];
    assert.ok(goodsMessage.content.includes('20 GB'));
    assert.ok(goodsMessage.content.includes(origin + '/dashboard/subscription'));
    assert.ok(!goodsMessage.content.includes('/register'));
    assert.equal(goodsInvitation.token_hash, 'storage-addon:' + createHash('sha256').update(goodsMessage.code).digest('hex'));
    assert.ok(!goodsDelivery.encrypted_code.includes(goodsMessage.code));
    const goodsRegister = await request('/register', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({
      username: 'addon-registration', displayName: 'Addon registration', password, passwordConfirmation: password, invitation: goodsMessage.code,
    }) });
    assert.equal(goodsRegister.status, 400);
    assert.equal(catalog.prepare('SELECT used_at FROM invitations WHERE id=?').get(goodsDelivery.invitation_id).used_at, null);
    const memberBefore = catalog.prepare("SELECT * FROM users WHERE login_id='delivered-member'").get();
    const redeemGoods = await request('/api/profile/subscription', {
      method: 'POST', headers: { Origin: origin, Cookie: memberCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: goodsMessage.code }),
    });
    assert.equal(redeemGoods.status, 200);
    const redeemedGoods = await redeemGoods.json();
    assert.equal(redeemedGoods.subscription.storageAddonBytes, 20 * gib);
    assert.equal(redeemedGoods.subscription.totalQuotaBytes, 25 * gib);
    assert.deepEqual({ ...catalog.prepare('SELECT * FROM users WHERE id=?').get(memberBefore.id) }, { ...memberBefore, storage_addon_bytes: 20 * gib });
    assert.equal(catalog.prepare('SELECT used_by FROM invitations WHERE id=?').get(goodsDelivery.invitation_id).used_by, memberBefore.id);
    expectedUsers = catalog.prepare('SELECT * FROM users ORDER BY id').all();

    await nextMinute();
    goodsOrder('goods-retry'); provider.sendFailure = true; await saveProvider();
    assert.equal((await claim('goods-retry')).status, 502);
    const pendingGoods = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('goods-retry');
    assert.equal(pendingGoods.state, 'pending');
    const countWithPendingGoods = catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    const beforeGoodsRetrySends = (await events()).filter(event => event.type !== 'query');
    provider.sendFailure = false;
    for (const fields of [
      { status: 0 }, { user_id: 'changed-buyer' }, { plan_id: 'f'.repeat(32) }, { month: 1 }, { total_amount: '95.01' },
      { sku_detail: [{ sku_id: smallSku, count: 1 }, { sku_id: largeSku, count: 2 }] },
    ]) {
      await nextMinute();
      goodsOrder('goods-retry', fields); await saveProvider();
      assert.equal((await claim('goods-retry')).status, 409);
    }
    assert.deepEqual((await events()).filter(event => event.type !== 'query'), beforeGoodsRetrySends);
    assert.deepEqual(catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('goods-retry'), pendingGoods);
    goodsOrder('goods-retry', { sku_detail: [{ sku_id: smallSku, count: 2 }, { sku_id: largeSku, count: 1 }] });
    goodsOrder('old-catalog-price');
    await saveProvider();
    await stop();
    await start({ ...environment, AFDIAN_STORAGE_ADDONS: JSON.stringify(addonCatalog.map(item => ({
      ...item, priceCents: item.priceCents + 100, addOnBytes: item.addOnBytes * 2,
    }))) });
    assert.equal((await claim('old-catalog-price')).status, 409);
    assert.equal((await claim('goods-retry')).status, 200);
    const sentGoodsRetry = catalog.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?').get('goods-retry');
    assert.equal(sentGoodsRetry.invitation_id, pendingGoods.invitation_id);
    assert.equal(sentGoodsRetry.encrypted_code, pendingGoods.encrypted_code);
    assert.equal(sentGoodsRetry.attempts, 2);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, countWithPendingGoods);
    const goodsRetryMessages = (await events()).filter(event => event.type === 'send' && event.recipient === 'buyer-goods-retry');
    assert.equal(goodsRetryMessages.length, 2);
    assert.equal(goodsRetryMessages[0].code, goodsRetryMessages[1].code);
    assert.equal(goodsRetryMessages[0].content, goodsRetryMessages[1].content);
    assert.ok(goodsRetryMessages[1].content.includes('20 GB'));

    await stop();
    await start({ ...environment, AFDIAN_STORAGE_ADDONS: JSON.stringify([...addonCatalog, addonCatalog[0]]) });
    goodsOrder('duplicate-config-goods'); order('subscription-with-bad-goods-config'); await saveProvider();
    assert.deepEqual(await (await request('/api/integrations/afdian/delivery/status')).json(), { configured: true });
    assert.equal((await claim('duplicate-config-goods')).status, 409);
    assert.equal((await claim('subscription-with-bad-goods-config')).status, 200);
    await stop();
    await start({ ...environment, AFDIAN_YEARLY_PLAN_ID: '' });
    assert.deepEqual(await (await request('/api/integrations/afdian/delivery/status')).json(), { configured: false });
    const beforeUnconfigured = await events();
    assert.equal((await claim('monthly-order')).status, 503);
    assert.deepEqual(await events(), beforeUnconfigured);
    assert.deepEqual(catalog.prepare('SELECT * FROM users ORDER BY id').all(), expectedUsers);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM platform_migrations WHERE name=?').get('afdian-order-deliveries').count, 1);
    assert.equal(catalog.prepare('SELECT COUNT(*) AS count FROM platform_migrations WHERE name=?').get('afdian-storage-addon-deliveries').count, 1);
  } finally {
    catalog?.close(); await stop();
    assert.ok(data.startsWith(resolve(tmpdir()) + sep + 'yangyu-afdian-delivery-'));
    await rm(data, { recursive: true, force: true });
  }
});

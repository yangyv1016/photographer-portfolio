import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { origin } from './config.mjs';
import { platformDatabase } from './platform-database.mjs';
import { insertStorageAddonCode, insertSubscriptionCode, subscriptionPlans } from './subscriptions.mjs';

const claimSchema = z.object({ orderNo: z.string().trim().min(1).max(100) }).strict();
const moneySchema = z.string().max(32).regex(/^\d+(?:\.\d{1,2})?$/);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const skuIdSchema = z.string().min(1).max(128).refine(id => id === id.trim());
const skuDetailsSchema = z.array(z.object({ sku_id: skuIdSchema, count: positiveSafeInteger })).min(1);
const storageAddonCatalogSchema = z.array(z.object({
  planId: z.string().regex(/^[a-f0-9]{32}$/i), skuId: skuIdSchema,
  priceCents: positiveSafeInteger, addOnBytes: positiveSafeInteger,
}).strict());
const orderResponseSchema = z.object({ list: z.array(z.object({
  out_trade_no: z.string().min(1).max(100), user_id: z.string().min(1).max(128),
  plan_id: z.string().min(1).max(128), month: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_amount: moneySchema, status: z.number().int(), product_type: z.number().int(),
  redeem_id: z.string().nullish(), sku_detail: z.unknown().optional(),
})).max(100) });
const randomReplySchema = z.object({ list: z.array(z.object({ out_trade_no: z.string().min(1).max(100), content: z.string() })).max(100) });
const apiResponseSchema = z.object({ ec: z.number().int(), data: z.unknown().optional() });
const readDelivery = platformDatabase.prepare('SELECT * FROM afdian_order_deliveries WHERE out_trade_no=?');
let currentMinute;
let minuteRequests = 0;
const requestsByIp = new Map();
let sendSecond;
let secondSends = 0;

function readStorageAddonCatalog(value) {
  if (!value) return new Map();
  let entries;
  try { entries = JSON.parse(value); }
  catch { return new Map(); }
  const parsed = storageAddonCatalogSchema.safeParse(entries);
  if (!parsed.success) return new Map();
  const catalog = new Map();
  for (const item of parsed.data) {
    const skus = catalog.get(item.planId) ?? new Map();
    if (skus.has(item.skuId)) return new Map();
    skus.set(item.skuId, item);
    catalog.set(item.planId, skus);
  }
  return catalog;
}

function deliveryConfiguration() {
  const userId = process.env.AFDIAN_USER_ID;
  const token = process.env.AFDIAN_API_TOKEN;
  const deliveryKey = process.env.AFDIAN_DELIVERY_KEY;
  const plans = [
    { afdianPlanId: process.env.AFDIAN_MONTHLY_PLAN_ID, subscriptionPlanId: 'monthly', monthsPerPeriod: 1 },
    { afdianPlanId: process.env.AFDIAN_QUARTERLY_PLAN_ID, subscriptionPlanId: 'quarterly', monthsPerPeriod: 3 },
    { afdianPlanId: process.env.AFDIAN_YEARLY_PLAN_ID, subscriptionPlanId: 'yearly', monthsPerPeriod: 12 },
  ];
  if (!userId || !/^[a-f0-9]{32}$/i.test(userId) || !token?.trim() || !deliveryKey || !/^[a-f0-9]{64}$/i.test(deliveryKey)
    || plans.some(item => !item.afdianPlanId || !/^[a-f0-9]{32}$/i.test(item.afdianPlanId))
    || new Set(plans.map(item => item.afdianPlanId)).size !== 3) return null;
  return {
    userId, token, deliveryKey: Buffer.from(deliveryKey, 'hex'), plans,
    storageAddons: readStorageAddonCatalog(process.env.AFDIAN_STORAGE_ADDONS),
  };
}

export function deliveryConfigurationStatus() {
  return { configured: deliveryConfiguration() !== null };
}

class AfdianDeliveryError extends Error {
  constructor(kind) { super('Afdian delivery request failed.'); this.kind = kind; }
}

async function requestAfdian(configuration, path, parameters) {
  const params = JSON.stringify(parameters);
  const ts = Math.floor(Date.now() / 1000);
  const sign = createHash('md5').update(`${configuration.token}params${params}ts${ts}user_id${configuration.userId}`).digest('hex');
  let response;
  try {
    response = await fetch('https://ifdian.net/api/open/' + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: configuration.userId, params, ts, sign }),
    });
  } catch { throw new AfdianDeliveryError('network'); }
  if (!response.ok) throw new AfdianDeliveryError('http');
  let body;
  try { body = await response.json(); }
  catch { throw new AfdianDeliveryError('response'); }
  const parsed = apiResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.ec !== 200) throw new AfdianDeliveryError('provider');
  return parsed.data.data;
}

// Recheck before provider calls and again while taking a send lease.
function unavailableInvitationResponse(delivery, now) {
  const invitation = platformDatabase.prepare('SELECT used_at,revoked_at,expires_at FROM invitations WHERE id=?').get(delivery.invitation_id);
  if (invitation.used_at !== null) return Response.json({ status: 'sent', message: '该订单兑换码已使用，无需再次发货。请在已兑换账户中查看订阅。' });
  if (invitation.revoked_at !== null || (invitation.expires_at !== null && invitation.expires_at <= now)) {
    return Response.json({ error: '该订单兑换码已失效，请联系管理员处理。' }, { status: 409 });
  }
  return null;
}

function ineligibleOrder() {
  return Response.json({ error: '订单暂不符合自动发货条件，请确认订单号或联系管理员。' }, { status: 409 });
}

function calculateStorageAddonBytes(skus, quantities, amountCents) {
  if (!skus) return null;
  let priceCents = 0n;
  let addOnBytes = 0n;
  for (const [skuId, count] of quantities) {
    const item = skus.get(skuId);
    if (!item) return null;
    priceCents += BigInt(item.priceCents) * BigInt(count);
    addOnBytes += BigInt(item.addOnBytes) * BigInt(count);
  }
  return priceCents === amountCents && addOnBytes <= maxSafeInteger ? Number(addOnBytes) : null;
}

export async function claimAfdianOrder(request, clientIp) {
  if (request.method !== 'POST') return Response.json({ error: '请使用 POST 提交订单号。' }, { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.get('origin') !== origin) return Response.json({ error: '请从本站领取页面提交。' }, { status: 403 });
  const configuration = deliveryConfiguration();
  if (!configuration) return Response.json({ error: '自助发货通道正在配置，请稍后再试或联系管理员。' }, { status: 503 });
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (minute !== currentMinute) { currentMinute = minute; minuteRequests = 0; requestsByIp.clear(); }
  const ipRequests = requestsByIp.get(clientIp) ?? 0;
  if (minuteRequests >= 15 || ipRequests >= 5) return Response.json({ error: '领取请求过于频繁，请稍后再试。' }, { status: 429, headers: { 'Retry-After': '60' } });
  minuteRequests++;
  requestsByIp.set(clientIp, ipRequests + 1);
  let body;
  try { body = await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return Response.json({ error: '请提交有效的订单号。' }, { status: 400 });
  }
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: '请填写完整的爱发电订单号。' }, { status: 400 });
  const { orderNo } = parsed.data;
  let delivery = readDelivery.get(orderNo);
  if (delivery?.state === 'sent') return Response.json({ status: 'sent', message: '该订单已完成发货，请前往下单爱发电账号的私信查看兑换码。' });
  if (delivery) {
    const unavailable = unavailableInvitationResponse(delivery, now);
    if (unavailable) return unavailable;
  }
  if (delivery && ((delivery.state === 'sending' && delivery.lease_until > now) || delivery.next_attempt_at > now)) {
    return Response.json({ status: 'processing', message: '订单正在处理中，请稍后再试并查看下单账号的爱发电私信。' }, { status: 202, headers: { 'Retry-After': '60' } });
  }

  let orderData;
  try { orderData = await requestAfdian(configuration, 'query-order', { out_trade_no: orderNo }); }
  catch (error) {
    if (!(error instanceof AfdianDeliveryError)) throw error;
    return Response.json({ error: '暂时无法核验订单，请稍后再试。' }, { status: 502 });
  }
  const verified = orderResponseSchema.safeParse(orderData);
  if (!verified.success) return Response.json({ error: '订单核验结果异常，请联系管理员。' }, { status: 502 });
  const order = verified.data.list.length === 1 ? verified.data.list[0] : null;
  if (!order || order.out_trade_no !== orderNo || order.status !== 2 || order.redeem_id
    || (order.product_type !== 0 && order.product_type !== 1)) return ineligibleOrder();
  const [whole, fraction = ''] = order.total_amount.split('.');
  const amountCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amountCents > maxSafeInteger) return ineligibleOrder();
  const isStorageAddon = order.product_type === 1;
  let skuQuantities = null;
  let addOnBytes;
  let plan;
  let durationDays;
  if (isStorageAddon) {
    const parsedSkus = skuDetailsSchema.safeParse(order.sku_detail);
    if (!parsedSkus.success) return ineligibleOrder();
    const quantities = new Map();
    for (const { sku_id, count } of parsedSkus.data) {
      if (quantities.has(sku_id)) return ineligibleOrder();
      quantities.set(sku_id, count);
    }
    skuQuantities = JSON.stringify([...quantities].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    if (!delivery) {
      addOnBytes = calculateStorageAddonBytes(configuration.storageAddons.get(order.plan_id), quantities, amountCents);
      if (addOnBytes === null) return ineligibleOrder();
    }
  } else {
    const mapping = configuration.plans.find(item => item.afdianPlanId === order.plan_id);
    if (!mapping) return ineligibleOrder();
    plan = subscriptionPlans.find(item => item.id === mapping.subscriptionPlanId);
    const periods = order.month / mapping.monthsPerPeriod;
    durationDays = plan.days * periods;
    if (!Number.isSafeInteger(periods) || periods <= 0 || !Number.isSafeInteger(durationDays * 86400000)
      || now + durationDays * 86400000 > 8640000000000000 || !Number.isSafeInteger(plan.priceCents * periods)
      || amountCents !== BigInt(plan.priceCents * periods)) return ineligibleOrder();
  }

  if (!delivery) {
    let historicalReply;
    try { historicalReply = await requestAfdian(configuration, 'query-random-reply', { out_trade_no: orderNo }); }
    catch (error) {
      if (!(error instanceof AfdianDeliveryError)) throw error;
      return Response.json({ error: '暂时无法核对历史发货记录，请稍后再试。' }, { status: 502 });
    }
    const reply = randomReplySchema.safeParse(historicalReply);
    if (!reply.success || reply.data.list.length > 1 || (reply.data.list.length === 1 && reply.data.list[0].out_trade_no !== orderNo)) {
      return Response.json({ error: '历史发货记录需要人工核对，请联系管理员。' }, { status: 502 });
    }
    if (reply.data.list.length === 1 && reply.data.list[0].content !== '') {
      return Response.json({ error: '该订单已有自动回复记录，请查看下单账号的爱发电私信；如需帮助请联系管理员。' }, { status: 409 });
    }
  }

  const leaseToken = randomUUID();
  let processing = false;
  let alreadySent = false;
  const attemptTime = Date.now();
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    delivery = readDelivery.get(orderNo);
    if (delivery && (delivery.buyer_id !== order.user_id || delivery.afdian_plan_id !== order.plan_id
      || delivery.order_months !== order.month || BigInt(delivery.paid_amount_cents) !== amountCents
      || delivery.sku_quantities !== skuQuantities || (delivery.subscription_plan === 'storage-addon') !== isStorageAddon)) {
      platformDatabase.exec('ROLLBACK');
      return Response.json({ error: '订单记录需要人工核对，请联系管理员。' }, { status: 409 });
    }
    if (delivery && delivery.state !== 'sent') {
      const unavailable = unavailableInvitationResponse(delivery, attemptTime);
      if (unavailable) { platformDatabase.exec('ROLLBACK'); return unavailable; }
    }
    if (delivery?.state === 'sent') alreadySent = true;
    else if (delivery && ((delivery.state === 'sending' && delivery.lease_until > attemptTime) || delivery.next_attempt_at > attemptTime)) processing = true;
    else {
      if (!delivery) {
        const administrator = platformDatabase.prepare("SELECT id FROM users WHERE role='admin' AND is_active=1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1").get();
        if (!administrator) {
          platformDatabase.exec('ROLLBACK');
          return Response.json({ error: '发货服务暂不可用，请联系管理员。' }, { status: 503 });
        }
        const issuance = { expiresAt: null, createdBy: administrator.id, note: '爱发电自助领取', now: attemptTime };
        const issued = isStorageAddon
          ? insertStorageAddonCode({ ...issuance, addOnBytes })
          : insertSubscriptionCode({ ...issuance, plan, durationDays });
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', configuration.deliveryKey, iv);
        cipher.setAAD(Buffer.from(orderNo));
        const encrypted = Buffer.concat([cipher.update(issued.code, 'utf8'), cipher.final()]);
        const encryptedCode = [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
        const timestamp = new Date(attemptTime).toISOString();
        platformDatabase.prepare(`INSERT INTO afdian_order_deliveries
          (out_trade_no,buyer_id,afdian_plan_id,subscription_plan,order_months,paid_amount_cents,sku_quantities,invitation_id,encrypted_code,state,next_attempt_at,attempts,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',0,0,?,?)`)
          .run(orderNo, order.user_id, order.plan_id, isStorageAddon ? 'storage-addon' : plan.id, order.month,
            Number(amountCents), skuQuantities, issued.invitationId, encryptedCode, timestamp, timestamp);
      }
      platformDatabase.prepare(`UPDATE afdian_order_deliveries SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1,
        updated_at=?,last_error=NULL WHERE out_trade_no=?`)
        .run(leaseToken, attemptTime + 90000, new Date(attemptTime).toISOString(), orderNo);
      delivery = readDelivery.get(orderNo);
    }
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
  if (alreadySent) return Response.json({ status: 'sent', message: '该订单已完成发货，请前往下单爱发电账号的私信查看兑换码。' });
  if (processing) return Response.json({ status: 'processing', message: '订单正在处理中，请稍后再试并查看下单账号的爱发电私信。' }, { status: 202, headers: { 'Retry-After': '60' } });

  try {
    const second = Math.floor(Date.now() / 1000);
    if (sendSecond !== second) { sendSecond = second; secondSends = 0; }
    if (secondSends >= 8) throw new AfdianDeliveryError('throttle');
    secondSends++;
    let code;
    try {
      const [iv, tag, encrypted] = delivery.encrypted_code.split('.').map(value => Buffer.from(value, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', configuration.deliveryKey, iv);
      decipher.setAAD(Buffer.from(orderNo));
      decipher.setAuthTag(tag);
      code = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch { throw new AfdianDeliveryError('encryption'); }
    const issued = platformDatabase.prepare('SELECT duration_days,quota_bytes,add_on_bytes FROM invitations WHERE id=?').get(delivery.invitation_id);
    const content = isStorageAddon
      ? `你的摄影师作品展示扩容兑换码：${code}\n增加容量：${issued.add_on_bytes / 1024 ** 3} GB\n登录已有账户后兑换：${origin}/dashboard/subscription\n扩容在主订阅有效期间可用。每个兑换码只能使用一次，请妥善保存。`
      : `你的摄影师作品展示订阅兑换码：${code}\n${plan.name} · ${issued.duration_days} 天 · ${issued.quota_bytes / 1024 ** 3} GB\n新用户注册：${origin}/register\n已有账户续期：${origin}/dashboard/subscription\n每个兑换码只能使用一次，请妥善保存。`;
    await requestAfdian(configuration, 'send-msg', { recipient: delivery.buyer_id, content });
  } catch (error) {
    if (!(error instanceof AfdianDeliveryError)) throw error;
    const failedAt = Date.now();
    platformDatabase.prepare(`UPDATE afdian_order_deliveries SET state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=?
      WHERE out_trade_no=? AND lease_token=?`)
      .run(failedAt + 60000, error.kind, new Date(failedAt).toISOString(), orderNo, leaseToken);
    return Response.json({ error: '私信暂未确认发送成功，请稍后重试；重复领取不会生成新的兑换码。' }, { status: 502, headers: { 'Retry-After': '60' } });
  }
  const sentAt = new Date(Date.now()).toISOString();
  platformDatabase.prepare(`UPDATE afdian_order_deliveries SET state='sent',lease_token=NULL,lease_until=NULL,next_attempt_at=0,sent_at=?,updated_at=?
    WHERE out_trade_no=? AND lease_token=?`).run(sentAt, sentAt, orderNo, leaseToken);
  return Response.json({ status: 'sent', message: '发货成功，请前往下单爱发电账号的私信查看兑换码。' });
}

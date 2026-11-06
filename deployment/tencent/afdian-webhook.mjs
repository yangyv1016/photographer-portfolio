import { z } from 'zod';
import { platformDatabase } from './platform-database.mjs';

const orderSchema = z.object({
  data: z.object({
    type: z.literal('order'),
    order: z.object({
      out_trade_no: z.string().trim().min(1).max(100),
      user_id: z.string().max(128).nullish(),
      plan_id: z.string().max(128).nullish(),
      month: z.number().int().nonnegative().nullish(),
      total_amount: z.string().max(32).regex(/^\d+(?:\.\d{1,2})?$/).nullish(),
      status: z.number().int().nonnegative().nullish(),
    }),
  }),
});
const recordReceipt = platformDatabase.prepare(`INSERT INTO afdian_webhook_receipts
  (out_trade_no,buyer_id,plan_id,month,total_amount,status,processing_state,first_received_at,last_received_at,delivery_count)
  SELECT ?,?,?,?,?,?,'pending_verification',?,?,1
  WHERE EXISTS (SELECT 1 FROM afdian_webhook_receipts WHERE out_trade_no=?)
    OR (SELECT COUNT(*) FROM afdian_webhook_receipts)<5000
  ON CONFLICT (out_trade_no) DO UPDATE SET
    last_received_at=excluded.last_received_at,delivery_count=delivery_count+1`);
let currentMinute;
let minuteRequests = 0;
const requestsByIp = new Map();

export async function receiveAfdianWebhook(request, clientIp) {
  if (request.method !== 'POST') {
    return Response.json({ ec: 405, em: '请使用 POST 发送订单通知。' }, { status: 405, headers: { Allow: 'POST' } });
  }
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (minute !== currentMinute) {
    currentMinute = minute;
    minuteRequests = 0;
    requestsByIp.clear();
  }
  const ipRequests = requestsByIp.get(clientIp) ?? 0;
  if (minuteRequests >= 120 || ipRequests >= 30) {
    return Response.json({ ec: 429, em: '通知过于频繁，请稍后重试。' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  minuteRequests++;
  requestsByIp.set(clientIp, ipRequests + 1);
  let body;
  try { body = await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return Response.json({ ec: 400, em: '订单通知必须为有效 JSON。' }, { status: 400 });
  }
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ec: 400, em: '订单通知格式无效。' }, { status: 400 });
  const order = parsed.data.data.order;
  const timestamp = new Date(now).toISOString();
  // Test receipt only: neither the signature nor payment is verified, and no entitlement is issued.
  const result = recordReceipt.run(order.out_trade_no, order.user_id ?? null, order.plan_id ?? null,
    order.month ?? null, order.total_amount ?? null, order.status ?? null, timestamp, timestamp, order.out_trade_no);
  if (!result.changes) {
    return Response.json({ ec: 503, em: '测试通知收件箱已满，请联系管理员处理后重试。' }, { status: 503, headers: { 'Retry-After': '3600' } });
  }
  return Response.json({ ec: 200, em: '通知已收件，尚未核验订单或自动发码。', mode: 'test', auto_fulfillment: false });
}

export function readAfdianWebhookReceipts(searchParams) {
  const parsed = z.coerce.number().int().min(1).safeParse(searchParams.get('page') ?? 1);
  if (!parsed.success) return Response.json({ error: '页码无效。' }, { status: 400 });
  const total = platformDatabase.prepare('SELECT COUNT(*) AS count FROM afdian_webhook_receipts').get().count;
  const page = Math.min(parsed.data, Math.max(1, Math.ceil(total / 50)));
  const receipts = platformDatabase.prepare(`SELECT out_trade_no AS outTradeNo,buyer_id AS buyerId,plan_id AS planId,
    month,total_amount AS totalAmount,status,processing_state AS processingState,
    first_received_at AS firstReceivedAt,last_received_at AS lastReceivedAt,delivery_count AS deliveryCount
    FROM afdian_webhook_receipts ORDER BY last_received_at DESC,out_trade_no LIMIT 50 OFFSET ?`).all((page - 1) * 50);
  return Response.json({ receipts, page, total, mode: 'test', autoFulfillment: false });
}

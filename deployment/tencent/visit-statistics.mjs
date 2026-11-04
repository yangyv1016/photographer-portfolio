import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { origin } from './config.mjs';
import { getPublicAccount, platformDatabase } from './platform-database.mjs';

const dayMilliseconds = 24 * 60 * 60 * 1000;
const shanghaiOffset = 8 * 60 * 60 * 1000;
const retentionDays = 90;
const cookieName = 'yangyu_visitor';
const cookieSeconds = 30 * 24 * 60 * 60;
const dayLabel = time => new Date(time).toISOString().slice(0, 10);

platformDatabase.exec(`
  CREATE TABLE IF NOT EXISTS visitor_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    signing_key TEXT NOT NULL,
    available_from TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_visits (
    visit_date TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    storage_id TEXT NOT NULL REFERENCES users(storage_id),
    PRIMARY KEY (visit_date, visitor_hash, storage_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS daily_visits_account ON daily_visits(storage_id, visit_date);
`);
const readSettings = platformDatabase.prepare('SELECT signing_key, available_from FROM visitor_settings WHERE id = 1');
if (!readSettings.get()) {
  platformDatabase.prepare('INSERT OR IGNORE INTO visitor_settings VALUES (1, ?, ?)')
    .run(randomBytes(32).toString('hex'), dayLabel(Date.now() + shanghaiOffset));
}
const { signing_key: signingKey, available_from: availableFrom } = readSettings.get();
const insertVisit = platformDatabase.prepare('INSERT OR IGNORE INTO daily_visits VALUES (?, ?, ?)');
const countToday = platformDatabase.prepare('SELECT COUNT(*) AS visitors FROM daily_visits WHERE storage_id = ? AND visit_date = ?');
const pruneVisits = platformDatabase.prepare('DELETE FROM daily_visits WHERE visit_date < ?');
let lastPrunedDay;
let issuanceMinute;
const issuedByIp = new Map();

function visitDay(now) {
  const localTime = now + shanghaiOffset;
  const date = dayLabel(localTime);
  if (date !== lastPrunedDay) {
    pruneVisits.run(dayLabel(localTime - (retentionDays - 1) * dayMilliseconds));
    lastPrunedDay = date;
  }
  return { localTime, date };
}

function signVisitor(token) {
  return createHmac('sha256', signingKey).update(token).digest();
}

export function recordPublicVisit(request, publicId, clientIp) {
  if (request.method !== 'POST') {
    return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.headers.get('origin') !== origin) {
    return Response.json({ error: '请从本站执行此操作。' }, { status: 403 });
  }
  const account = getPublicAccount(publicId);
  if (!account) return Response.json({ error: '摄影师主页不存在。' }, { status: 404 });

  const now = Date.now();
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const signed = cookie?.match(/^([a-f0-9]{32})\.([a-f0-9]{64})$/);
  const headers = new Headers();
  let token;
  if (signed && timingSafeEqual(Buffer.from(signed[2], 'hex'), signVisitor(signed[1]))) {
    token = signed[1];
  } else {
    // Bound new anonymous identities without retaining addresses in the database.
    const minute = Math.floor(now / 60000);
    if (minute !== issuanceMinute) {
      issuedByIp.clear();
      issuanceMinute = minute;
    }
    const issued = issuedByIp.get(clientIp) ?? 0;
    if (issued >= 30 || (issued === 0 && issuedByIp.size >= 5000)) {
      return Response.json({ error: '访问登记过于频繁，请稍后重试。' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    issuedByIp.set(clientIp, issued + 1);
    token = randomBytes(16).toString('hex');
    const secure = origin.startsWith('https:') ? '; Secure' : '';
    headers.set('Set-Cookie', `${cookieName}=${token}.${signVisitor(token).toString('hex')}; Path=/api/visits; HttpOnly; SameSite=Strict; Max-Age=${cookieSeconds}${secure}`);
  }

  const { date } = visitDay(now);
  const visitorHash = createHash('sha256').update(`${date}:${token}`).digest('hex');
  insertVisit.run(date, visitorHash, account.storage_id);
  const { visitors: today } = countToday.get(account.storage_id, date);
  return Response.json({ today }, { headers });
}

export function visitStatistics(searchParams, account) {
  const range = searchParams.get('days') ?? '30';
  if (!['7', '30', '90'].includes(range)) {
    return Response.json({ error: '统计范围请选择 7、30 或 90 天。' }, { status: 400 });
  }
  const selectedId = searchParams.get('accountId');
  const admin = account.role === 'admin';
  if (!admin && selectedId !== null) {
    return Response.json({ error: '只能查看本人的访问统计。' }, { status: 403 });
  }
  let storageId = admin ? null : account.storage_id;
  if (selectedId !== null) {
    const id = Number(selectedId);
    if (!/^[1-9]\d*$/.test(selectedId) || !Number.isSafeInteger(id)) {
      return Response.json({ error: '摄影师编号无效。' }, { status: 400 });
    }
    const selected = platformDatabase.prepare('SELECT storage_id FROM users WHERE id = ?').get(id);
    if (!selected) return Response.json({ error: '摄影师账户不存在。' }, { status: 404 });
    storageId = selected.storage_id;
  }

  const { localTime, date: todayLabel } = visitDay(Date.now());
  const firstTime = localTime - (Number(range) - 1) * dayMilliseconds;
  const firstLabel = dayLabel(firstTime);
  const rows = storageId === null
    ? platformDatabase.prepare(`SELECT visit_date, COUNT(DISTINCT visitor_hash) AS visitors FROM daily_visits
        WHERE visit_date BETWEEN ? AND ? GROUP BY visit_date`).all(firstLabel, todayLabel)
    : platformDatabase.prepare(`SELECT visit_date, COUNT(*) AS visitors FROM daily_visits
        WHERE storage_id = ? AND visit_date BETWEEN ? AND ? GROUP BY visit_date`).all(storageId, firstLabel, todayLabel);
  const visitorsByDay = new Map(rows.map(row => [row.visit_date, row.visitors]));
  const days = Array.from({ length: Number(range) }, (_, index) => {
    const date = dayLabel(firstTime + index * dayMilliseconds);
    return { date, visitors: visitorsByDay.get(date) ?? 0 };
  });
  const accounts = admin ? platformDatabase.prepare(`SELECT id, display_name AS displayName, public_id AS publicId
      FROM users ORDER BY created_at, id`).all() : [];
  return Response.json({
    days, availableFrom, accounts,
    today: days.at(-1).visitors,
    total: days.reduce((sum, day) => sum + day.visitors, 0),
  });
}

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { platformDatabase } from './platform-database.mjs';
import { getCurrentAccount, createAccountGallery } from './database.mjs';
import { origin } from './config.mjs';
import { authPage } from './platform-html.mjs';
import { applySubscriptionInvitation, calculateSubscriptionExpiry } from './subscriptions.mjs';

const cookieName = 'yangyu_admin';
const sessionSeconds = 12 * 60 * 60;
const attempts = new Map();
export const reservedIds = new Set(['admin','login','register','logout','dashboard','api','assets','healthz','reset-password','photographers','claim']);
export const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function sessionHash(request) {
  const token = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
}

export function verifyPassword(password, saved) {
  const [salt, hash] = saved.split(':');
  return timingSafeEqual(scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }), Buffer.from(hash, 'hex'));
}

export function getSession(request) {
  const token = sessionHash(request);
  return token ? platformDatabase.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.is_active=1 AND users.deleted_at IS NULL`).get(token, Date.now()) ?? null : null;
}

export function requireSession(request) {
  const account = getSession(request);
  if (!account) return Response.json({ error: '请先登录。' }, { status: 401, headers: privateHeaders });
  if (!['GET','HEAD'].includes(request.method) && request.headers.get('origin') !== origin) return Response.json({ error: '请从本站执行此操作。' }, { status: 403, headers: privateHeaders });
  return null;
}

// Compatibility entry point for the existing owner-scoped photo management routes.
export async function checkAdmin(request) {
  const denied = requireSession(request);
  if (denied) return denied;
  if (getCurrentAccount()?.id !== getSession(request).id) return Response.json({ error: '无权管理此作品库。' }, { status: 403, headers: privateHeaders });
  return null;
}

function signIn(account) {
  const now = Date.now();
  const token = randomBytes(32).toString('hex');
  platformDatabase.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
  platformDatabase.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), account.id, now + sessionSeconds * 1000);
  return new Response(null, { status: 303, headers: { ...privateHeaders, Location: account.role === 'admin' ? '/admin' : '/dashboard', 'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${origin.startsWith('https:') ? '; Secure' : ''}` } });
}

export async function login(request, clientIp, registering = false) {
  const mode = registering ? 'register' : 'login';
  if (request.method === 'GET') {
    const account = getSession(request);
    return account ? new Response(null, { status: 303, headers: { ...privateHeaders, Location: account.role === 'admin' ? '/admin' : '/dashboard' } }) : new Response(authPage(mode), { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  if (request.headers.get('origin') !== origin) return new Response('请从本站登录或注册。', { status: 403, headers: privateHeaders });
  const now = Date.now();
  for (const [ip, item] of attempts) if (item.until <= now) attempts.delete(ip);
  const entry = attempts.get(clientIp) || { count: 0, until: now + 15 * 60 * 1000 };
  if (entry.count >= 8 || (!attempts.has(clientIp) && attempts.size >= 5000)) return new Response('尝试过于频繁，请稍后重试。', { status: 429, headers: { ...privateHeaders, 'Retry-After': '900' } });
  const form = await request.formData();
  const username = form.get('username');
  const password = form.get('password');
  let error = '账号或密码不正确。';
  let status = 401;
  if (typeof username === 'string' && username.length <= 80 && typeof password === 'string' && password.length <= 256) {
    if (!registering) {
      const account = platformDatabase.prepare('SELECT * FROM users WHERE login_id=? AND is_active=1 AND deleted_at IS NULL').get(username.trim());
      const valid = verifyPassword(password, account?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(64)}`);
      if (valid && account) { attempts.delete(clientIp); return signIn(account); }
    } else {
      const publicId = username.trim().toLowerCase();
      const invitation = form.get('invitation');
      const displayName = form.get('displayName');
      status = 400;
      if (!/^[a-z][a-z0-9_-]{2,23}$/.test(publicId) || reservedIds.has(publicId)) error = '登录 ID 需为 3–24 位小写字母、数字、下划线或连字符，以字母开头。';
      else if (password.length < 12 || form.get('passwordConfirmation') !== password) error = '请使用至少 12 个字符的密码，并确认两次输入一致。';
      else if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 40) error = '请填写 1–40 字的摄影师名称。';
      else if (typeof invitation !== 'string' || invitation.length > 100) error = '请输入有效的邀请码。';
      else {
        const hash = createHash('sha256').update(invitation.trim()).digest('hex');
        const savedPassword = hashPassword(password);
        platformDatabase.exec('BEGIN IMMEDIATE');
        try {
          const code = platformDatabase.prepare('SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(hash, now);
          if (!code || (code.subscription_plan !== null && calculateSubscriptionExpiry(code.duration_days, null, now) === null)) error = '邀请码不可用或已过期。';
          else if (platformDatabase.prepare('SELECT id FROM users WHERE login_id=? OR public_id=? UNION ALL SELECT user_id FROM public_id_aliases WHERE public_id=?').get(publicId, publicId, publicId)) { error = '这个登录 ID 已被使用，请更换。'; status = 409; }
          else {
            const created = platformDatabase.prepare("INSERT INTO users (login_id,public_id,storage_id,password_hash,display_name,site_name,role,quota_bytes,created_at) VALUES (?,?,?,?,?,?,'photographer',?,?)")
              .run(publicId, publicId, randomUUID(), savedPassword, displayName.trim(), displayName.trim(), code.quota_bytes, new Date(now).toISOString());
            const account = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(Number(created.lastInsertRowid));
            createAccountGallery(account.id,account.storage_id);
            if (code.subscription_plan !== null) applySubscriptionInvitation(account, code, now);
            platformDatabase.prepare('UPDATE invitations SET used_at=?,used_by=? WHERE id=? AND used_at IS NULL').run(new Date(now).toISOString(), account.id, code.id);
            platformDatabase.exec('COMMIT');
            attempts.delete(clientIp);
            return signIn(account);
          }
          platformDatabase.exec('ROLLBACK');
        } catch (failure) { platformDatabase.exec('ROLLBACK'); throw failure; }
      }
    }
  }
  entry.count++;
  attempts.set(clientIp, entry);
  return new Response(authPage(mode, error), { status, headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function logout(request) {
  const denied = requireSession(request);
  if (denied) return denied;
  platformDatabase.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(request));
  return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/login', 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}` } });
}

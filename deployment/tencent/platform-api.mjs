import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { freemem, totalmem, uptime, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { platformDatabase, publicAccount, defaultQuotaBytes, getStorageQuota } from './platform-database.mjs';
import { getAccountGallery, getGalleryNotes } from './database.mjs';
import { env, objectHead } from './storage.mjs';
import { dataDirectory, storageBackend } from './config.mjs';
import { verifyPassword, hashPassword, reservedIds } from './auth.mjs';
import { visitStatistics } from './visit-statistics.mjs';
import { subscriptionPlans, getSubscription, isSubscriptionExpired, createSubscriptionCodes, insertStorageAddonCode, readSubscriptionInvitation, applySubscriptionInvitation, calculateSubscriptionExpiry } from './subscriptions.mjs';
import { DELETE as cancelUpload } from '../../app/api/admin/uploads/route.ts';

export const uploadReservations = new Map();
const profileImageUploads = new Set();
const quotaSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const subscriptionPlanSchema = z.enum(['monthly','quarterly','yearly']);
const subscriptionExpirySchema = z.number().int().min(-8640000000000000).max(8640000000000000);
const durationDaysSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).refine(days => calculateSubscriptionExpiry(days, null, Date.now()) !== null);
const noteTitleSchema = z.string().trim().min(1).max(80);
const noteContentSchema = z.string().min(1).max(20000).refine(content => content.trim().length > 0);

export function accountUsage(account, now = Date.now()) {
  const sqlite = getAccountGallery(account.id,account.storage_id).sqlite;
  const photos = sqlite.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(object_sizes.size),0) AS bytes,
    COALESCE(SUM(CASE WHEN photos.image_key IS NOT NULL AND object_sizes.photo_id IS NULL THEN 1 ELSE 0 END),0) AS unmeasured
    FROM photos LEFT JOIN object_sizes ON object_sizes.photo_id=photos.id`).get();
  const storageBytes = photos.bytes + account.avatar_size + account.cover_size + account.directory_cover_size;
  const pendingBytes = sqlite.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM photo_uploads').get().bytes + (uploadReservations.get(account.id) ?? 0);
  const { totalQuotaBytes } = getStorageQuota(account);
  const subscriptionExpired = isSubscriptionExpired(account, now);
  return {
    photoCount: photos.count, seriesCount: sqlite.prepare('SELECT COUNT(*) AS count FROM series').get().count,
    storageBytes, storageComplete: photos.unmeasured === 0, pendingBytes,
    totalQuotaBytes, subscriptionExpired,
    availableBytes: subscriptionExpired ? 0 : Math.max(totalQuotaBytes - storageBytes - pendingBytes,0),
  };
}

export function checkStorageQuota(account, additionalBytes = 0) {
  const limits = platformDatabase.prepare('SELECT quota_bytes,storage_addon_bytes,avatar_size,cover_size,directory_cover_size,subscription_expires_at FROM users WHERE id=?').get(account.id);
  const current = { ...account, ...limits };
  const now = Date.now();
  if (isSubscriptionExpired(current, now)) return Response.json({ error: '订阅已到期，请兑换订阅码后再上传。' }, { status: 403 });
  const usage = accountUsage(current, now);
  if (!usage.storageComplete) return Response.json({ error: '照片容量正在核对，请稍后再上传。' }, { status: 409 });
  if (usage.storageBytes + usage.pendingBytes + additionalBytes > usage.totalQuotaBytes) return Response.json({ error: '上传容量不足，请取消未完成任务或联系管理员增加分配容量。', availableBytes: usage.availableBytes }, { status: 413 });
  return null;
}

export async function backfillStorage() {
  for (const account of platformDatabase.prepare('SELECT * FROM users').all()) {
    const sqlite = getAccountGallery(account.id,account.storage_id).sqlite;
    const rows = sqlite.prepare('SELECT id,image_key FROM photos WHERE image_key IS NOT NULL AND id NOT IN (SELECT photo_id FROM object_sizes)').all();
    for (const photo of rows) {
      try {
        const object = await objectHead(photo.image_key);
        if (!object) throw new Error('The registered image is missing from storage.');
        if (sqlite.prepare('SELECT id FROM photos WHERE id=?').get(photo.id)) sqlite.prepare('INSERT OR IGNORE INTO object_sizes VALUES (?,?)').run(photo.id, object.size);
      } catch { console.error('Unable to measure an existing photo.'); }
    }
  }
}

function storageQuotaAfterRedemption(account, invitation) {
  return getStorageQuota({
    quota_bytes: invitation.add_on_bytes > 0 ? account.quota_bytes : invitation.quota_bytes,
    storage_addon_bytes: account.storage_addon_bytes + invitation.add_on_bytes,
  });
}

export async function platformApi(request, account) {
  const { pathname: path, searchParams } = new URL(request.url);
  if (path === '/api/session') return Response.json({ account: publicAccount(account), usage: accountUsage(account) });
  if (path === '/api/profile/subscription') {
    if (request.method === 'GET') {
      const current = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(account.id);
      const now = Date.now();
      return Response.json({ subscription: getSubscription(current, now), plans: subscriptionPlans, usage: accountUsage(current, now) });
    }
    if (request.method !== 'POST') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'GET, POST' } });
    if (account.role === 'admin') return Response.json({ error: '平台管理员无需兑换订阅，请保留兑换码。' }, { status: 409 });
    const parsed = z.object({ code: z.string().trim().min(1).max(100) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '请输入有效的订阅兑换码。' }, { status: 400 });
    const now = Date.now();
    let updated;
    platformDatabase.exec('BEGIN IMMEDIATE');
    try {
      const current = platformDatabase.prepare('SELECT * FROM users WHERE id=? AND is_active=1 AND deleted_at IS NULL').get(account.id);
      if (!current) { platformDatabase.exec('ROLLBACK'); return Response.json({ error: '请重新登录。' }, { status: 401 }); }
      const invitation = readSubscriptionInvitation(parsed.data.code, now);
      if (!invitation) { platformDatabase.exec('ROLLBACK'); return Response.json({ error: '订阅兑换码不可用、已使用或已过期。' }, { status: 409 }); }
      const nextQuota = storageQuotaAfterRedemption(current, invitation);
      if (!Number.isSafeInteger(nextQuota.totalQuotaBytes)) {
        platformDatabase.exec('ROLLBACK');
        return Response.json({ error: '兑换后的总容量超出支持范围，请联系管理员。' }, { status: 409 });
      }
      if (invitation.add_on_bytes > 0) {
        platformDatabase.prepare('UPDATE users SET storage_addon_bytes=? WHERE id=?').run(nextQuota.storageAddonBytes, current.id);
      } else {
        if (invitation.grants_permanent !== 1 && calculateSubscriptionExpiry(invitation.duration_days, current.subscription_expires_at, now) === null) {
          platformDatabase.exec('ROLLBACK');
          return Response.json({ error: '续期后的到期时间超出支持范围，请联系管理员。' }, { status: 409 });
        }
        applySubscriptionInvitation(current, invitation, now);
      }
      platformDatabase.prepare('UPDATE invitations SET used_at=?,used_by=? WHERE id=?').run(new Date(now).toISOString(), current.id, invitation.id);
      updated = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(current.id);
      platformDatabase.exec('COMMIT');
    } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
    return Response.json({ subscription: getSubscription(updated, now), usage: accountUsage(updated, now) });
  }
  if (path === '/api/profile/subscription/preview') {
    if (request.method !== 'POST') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'POST' } });
    if (account.role === 'admin') return Response.json({ error: '平台管理员无需兑换订阅，请保留兑换码。' }, { status: 409 });
    const parsed = z.object({ code: z.string().trim().min(1).max(100) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '请输入有效的订阅兑换码。' }, { status: 400 });
    const now = Date.now();
    const invitation = readSubscriptionInvitation(parsed.data.code, now);
    if (!invitation) return Response.json({ error: '订阅兑换码不可用、已使用或已过期。' }, { status: 409 });
    const current = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(account.id);
    const nextQuota = storageQuotaAfterRedemption(current, invitation);
    if (!Number.isSafeInteger(nextQuota.totalQuotaBytes)) return Response.json({ error: '兑换后的总容量超出支持范围，请联系管理员。' }, { status: 409 });
    if (invitation.add_on_bytes > 0) {
      return Response.json({
        storageAddon: { addedBytes: invitation.add_on_bytes, nextStorageAddonBytes: nextQuota.storageAddonBytes },
        nextTotalQuotaBytes: nextQuota.totalQuotaBytes,
        subscription: getSubscription(current, now), usage: accountUsage(current, now),
      });
    }
    const permanent = invitation.grants_permanent === 1;
    const plan = permanent ? { id: 'permanent', name: '长期有效' } : subscriptionPlans.find(item => item.id === invitation.subscription_plan);
    const nextExpiresAt = permanent ? null : calculateSubscriptionExpiry(invitation.duration_days, current.subscription_expires_at, now);
    if (!permanent && nextExpiresAt === null) return Response.json({ error: '续期后的到期时间超出支持范围，请联系管理员。' }, { status: 409 });
    return Response.json({
      plan: { ...plan, days: invitation.duration_days, quotaBytes: invitation.quota_bytes, permanent },
      subscription: getSubscription(current, now), usage: accountUsage(current, now),
      nextExpiresAt, nextTotalQuotaBytes: nextQuota.totalQuotaBytes,
    });
  }
  if (path === '/api/profile/subscription/reminder') {
    if (request.method !== 'POST') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'POST' } });
    const now = Date.now();
    const current = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(account.id);
    const subscription = getSubscription(current, now);
    const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    let showReminder = false;
    if (!subscription.permanent && !subscription.expired && subscription.daysRemaining <= 7) {
      const result = platformDatabase.prepare(`UPDATE users SET subscription_reminded_on=? WHERE id=? AND subscription_expires_at=?
        AND (subscription_reminded_on IS NULL OR subscription_reminded_on<>?)`)
        .run(today, current.id, current.subscription_expires_at, today);
      showReminder = result.changes === 1;
    }
    return Response.json({ showReminder, subscription });
  }
  if (path === '/api/profile/visits') {
    if (request.method !== 'GET') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'GET' } });
    return visitStatistics(searchParams, account);
  }
  if (path === '/api/profile/notes/pin' || path === '/api/profile/notes/order') {
    if (request.method !== 'POST') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'POST' } });
    const pinning = path === '/api/profile/notes/pin';
    const schema = pinning ? z.object({ id: z.string().uuid(), isPinned: z.boolean() }) : z.object({ ids: z.array(z.string().uuid()).max(100) });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success || (!pinning && new Set(parsed.data.ids).size !== parsed.data.ids.length)) return Response.json({ error: '便签排序无效，请刷新后重试。' }, { status: 400 });
    const sqlite = getAccountGallery(account.id,account.storage_id).sqlite;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      if (pinning) {
        const note = sqlite.prepare('SELECT is_pinned AS isPinned FROM notes WHERE id=?').get(parsed.data.id);
        if (!note) { sqlite.exec('ROLLBACK'); return Response.json({ error: '便签不存在。' }, { status: 404 }); }
        if (note.isPinned !== Number(parsed.data.isPinned)) {
          sqlite.prepare('UPDATE notes SET is_pinned=?,sort_order=(SELECT COALESCE(MIN(sort_order),0)-1 FROM notes WHERE is_pinned=?) WHERE id=?')
            .run(Number(parsed.data.isPinned),Number(parsed.data.isPinned),parsed.data.id);
        }
      } else {
        const current = sqlite.prepare('SELECT id,is_pinned AS isPinned FROM notes').all();
        const currentNotes = new Map(current.map(note=>[note.id,note]));
        if (parsed.data.ids.length !== currentNotes.size || parsed.data.ids.some(id=>!currentNotes.has(id))) {
          sqlite.exec('ROLLBACK');
          return Response.json({ error: '便签列表已变化，请刷新后再调整顺序。' }, { status: 409 });
        }
        let unpinned = false;
        for (const id of parsed.data.ids) {
          if (!currentNotes.get(id).isPinned) unpinned = true;
          else if (unpinned) {
            sqlite.exec('ROLLBACK');
            return Response.json({ error: '置顶便签应排在前面，请刷新后再调整组内顺序。' }, { status: 409 });
          }
        }
        const update = sqlite.prepare('UPDATE notes SET sort_order=? WHERE id=?');
        for (const [index,id] of parsed.data.ids.entries()) update.run(index,id);
      }
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    return Response.json({ saved: true });
  }
  if (path === '/api/profile/notes') {
    const sqlite = getAccountGallery(account.id,account.storage_id).sqlite;
    if (request.method === 'GET') return Response.json({ notes: getGalleryNotes(account.id,account.storage_id) });
    if (!['POST','PATCH','DELETE'].includes(request.method)) return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } });
    const schema = request.method === 'POST' ? z.object({ title: noteTitleSchema, content: noteContentSchema })
      : request.method === 'PATCH' ? z.object({ id: z.string().uuid(), title: noteTitleSchema, content: noteContentSchema }) : z.object({ id: z.string().uuid() });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '便签标题需为 1–80 字，内容需为 1–20000 字，请检查便签编号。' }, { status: 400 });
    if (request.method === 'POST') {
      const note = { id: randomUUID(), title: parsed.data.title, content: parsed.data.content, createdAt: new Date().toISOString() };
      note.updatedAt = note.createdAt;
      note.isPinned = false;
      note.sortOrder = sqlite.prepare('SELECT COALESCE(MIN(sort_order),0)-1 AS position FROM notes WHERE is_pinned=0').get().position;
      const result = sqlite.prepare('INSERT INTO notes (id,title,content,created_at,updated_at,sort_order) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM notes)<100').run(note.id,note.title,note.content,note.createdAt,note.updatedAt,note.sortOrder);
      if (result.changes === 0) return Response.json({ error: '最多保存 100 条便签，请先删除不需要的内容。' }, { status: 409 });
      return Response.json({ note }, { status: 201 });
    }
    if (request.method === 'PATCH') {
      const result = sqlite.prepare('UPDATE notes SET title=?,content=?,updated_at=? WHERE id=?').run(parsed.data.title,parsed.data.content,new Date().toISOString(),parsed.data.id);
      return result.changes ? Response.json({ saved: true }) : Response.json({ error: '便签不存在。' }, { status: 404 });
    }
    const result = sqlite.prepare('DELETE FROM notes WHERE id=?').run(parsed.data.id);
    return result.changes ? Response.json({ deleted: true }) : Response.json({ error: '便签不存在。' }, { status: 404 });
  }
  if (path === '/api/profile/listing') {
    if (request.method !== 'PATCH') return Response.json({ error: '不支持此操作。' }, { status: 405, headers: { Allow: 'PATCH' } });
    const parsed = z.object({ listed: z.boolean() }).strict().safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '请选择是否在摄影师目录中展示主页。' }, { status: 400 });
    platformDatabase.prepare('UPDATE users SET listed=? WHERE id=?').run(Number(parsed.data.listed), account.id);
    return Response.json({ listed: parsed.data.listed });
  }
  if (path === '/api/profile' && request.method === 'GET') return Response.json({ account: publicAccount(account), usage: accountUsage(account) });
  if (path === '/api/profile' && request.method === 'PATCH') {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(40), siteName: z.string().trim().min(1).max(40).optional(), publicId: z.string().trim().regex(/^[a-z][a-z0-9_-]{2,23}$/).optional(), bio: z.string().trim().max(240), introduction: z.string().trim().max(1000).optional(), region: z.string().trim().max(80).optional(), showPhotoNames: z.boolean().optional(), listed: z.boolean().optional() }).safeParse(await request.json());
    if (!parsed.success || reservedIds.has(parsed.data.publicId ?? account.public_id)) return Response.json({ error: '请检查名称、签名、简介、地区和主页 ID；签名最多 240 字，简介最多 1000 字，地区最多 80 字。主页 ID 需为 3–24 位小写字母、数字、下划线或连字符，以字母开头。' }, { status: 400 });
    const { displayName, bio } = parsed.data;
    const listed = parsed.data.listed === undefined ? null : Number(parsed.data.listed);
    const siteName = parsed.data.siteName ?? account.site_name;
    const introduction = parsed.data.introduction ?? account.introduction;
    const region = parsed.data.region ?? account.region;
    const showPhotoNames = parsed.data.showPhotoNames ?? (account.show_photo_names === 1);
    const publicId = parsed.data.publicId ?? account.public_id;
    platformDatabase.exec('BEGIN IMMEDIATE');
    try {
      const conflict = platformDatabase.prepare('SELECT id FROM users WHERE public_id=? AND id<>? UNION ALL SELECT user_id FROM public_id_aliases WHERE public_id=? AND user_id<>?').get(publicId, account.id, publicId, account.id);
      if (conflict) { platformDatabase.exec('ROLLBACK'); return Response.json({ error: '这个主页 ID 已被使用。' }, { status: 409 }); }
      if (publicId !== account.public_id) {
        platformDatabase.prepare('INSERT OR IGNORE INTO public_id_aliases VALUES (?,?)').run(account.public_id, account.id);
        platformDatabase.prepare('DELETE FROM public_id_aliases WHERE public_id=? AND user_id=?').run(publicId, account.id);
      }
      platformDatabase.prepare('UPDATE users SET display_name=?,site_name=?,public_id=?,bio=?,introduction=?,region=?,show_photo_names=?,listed=COALESCE(?,listed) WHERE id=?').run(displayName, siteName, publicId, bio, introduction, region, Number(showPhotoNames), listed, account.id);
      platformDatabase.exec('COMMIT');
    } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
    return Response.json({ saved: true });
  }
  if (path === '/api/profile/login-id' && request.method === 'POST') {
    const parsed = z.object({ loginId: z.string().trim().regex(/^[a-z][a-z0-9_-]{2,23}$/), confirmationLoginId: z.string().trim().max(24), currentPassword: z.string().min(1).max(256) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '登录名需为 3–24 位小写字母、数字、下划线或连字符，以字母开头，并填写当前密码。' }, { status: 400 });
    const { loginId, confirmationLoginId, currentPassword } = parsed.data;
    if (loginId !== confirmationLoginId) return Response.json({ error: '请再次输入相同的新登录名以确认修改。' }, { status: 400 });
    if (loginId.toLowerCase() === account.login_id.toLowerCase()) return Response.json({ error: '新登录名与当前登录名相同。' }, { status: 400 });
    if (!verifyPassword(currentPassword, account.password_hash)) return Response.json({ error: '当前密码不正确。' }, { status: 400 });
    platformDatabase.exec('BEGIN IMMEDIATE');
    try {
      if (platformDatabase.prepare('SELECT id FROM users WHERE login_id=? AND id<>?').get(loginId, account.id)) {
        platformDatabase.exec('ROLLBACK');
        return Response.json({ error: '这个登录名已被使用。' }, { status: 409 });
      }
      platformDatabase.prepare('UPDATE users SET login_id=? WHERE id=?').run(loginId, account.id);
      platformDatabase.prepare('DELETE FROM sessions WHERE user_id=?').run(account.id);
      platformDatabase.exec('COMMIT');
    } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
    return Response.json({ saved: true, signInRequired: true });
  }
  if (path === '/api/profile/uploads' && request.method === 'GET') {
    const uploads=getAccountGallery(account.id,account.storage_id).sqlite.prepare('SELECT id,title,size,created_at AS createdAt FROM photo_uploads ORDER BY created_at').all();
    return Response.json({uploads});
  }
  if (path === '/api/profile/uploads' && request.method === 'DELETE') return cancelUpload(request);
  if (path === '/api/profile/password' && request.method === 'POST') {
    const parsed = z.object({ currentPassword: z.string().max(256), password: z.string().min(12).max(256) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '新密码至少 12 个字符。' }, { status: 400 });
    if (!verifyPassword(parsed.data.currentPassword, account.password_hash)) return Response.json({ error: '当前密码不正确。' }, { status: 400 });
    const passwordHash = hashPassword(parsed.data.password);
    platformDatabase.exec('BEGIN IMMEDIATE');
    try {
      platformDatabase.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, account.id);
      platformDatabase.prepare('DELETE FROM sessions WHERE user_id=?').run(account.id);
      platformDatabase.exec('COMMIT');
    } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
    return Response.json({ saved: true, signInRequired: true });
  }
  const imageField = path === '/api/profile/avatar' ? 'avatar' : path === '/api/profile/cover' ? 'cover' : path === '/api/profile/directory-cover' ? 'directory_cover' : null;
  const imageLabel = imageField === 'cover' ? '封面' : imageField === 'directory_cover' ? '目录卡片背景' : '头像';
  if (imageField && request.method === 'DELETE') {
    if (profileImageUploads.has(account.id)) return Response.json({ error: '资料图片正在保存，请稍后再试。' }, { status: 409 });
    profileImageUploads.add(account.id);
    try {
      const image = platformDatabase.prepare(`SELECT ${imageField}_key AS imageKey FROM users WHERE id=?`).get(account.id);
      if (image.imageKey) await env.BUCKET.delete(image.imageKey);
      platformDatabase.prepare(`UPDATE users SET ${imageField}_key=NULL,${imageField}_size=0 WHERE id=?`).run(account.id);
      return Response.json({ saved: true });
    } finally { profileImageUploads.delete(account.id); }
  }
  if (imageField && request.method === 'POST') {
    const type = request.headers.get('content-type');
    const bytes = Buffer.from(await request.arrayBuffer());
    const valid = type === 'image/webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'
      : type === 'image/png' ? Buffer.from([137,80,78,71,13,10,26,10]).equals(bytes.subarray(0,8))
      : type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const maximumMiB = imageField === 'avatar' ? 1 : 4;
    if (!valid || !bytes.length || bytes.length > maximumMiB * 1024 ** 2) return Response.json({ error: `${imageLabel}需为 ${maximumMiB} MiB 以内的 JPG、PNG 或 WebP。` }, { status: 400 });
    if (profileImageUploads.has(account.id)) return Response.json({ error: '资料图片正在保存，请稍后再试。' }, { status: 409 });
    const image = platformDatabase.prepare(`SELECT ${imageField}_key AS imageKey,${imageField}_size AS imageSize FROM users WHERE id=?`).get(account.id);
    const reserved = Math.max(bytes.length - image.imageSize, 0);
    const quotaDenied = checkStorageQuota(account,reserved);
    if (quotaDenied) return quotaDenied;
    profileImageUploads.add(account.id);
    uploadReservations.set(account.id, (uploadReservations.get(account.id) ?? 0) + reserved);
    const key = `photos/${imageField === 'cover' ? 'covers' : imageField === 'directory_cover' ? 'directory-covers' : 'avatars'}/${account.id}/${randomUUID()}.${type === 'image/jpeg' ? 'jpg' : type.split('/')[1]}`;
    let complete = false;
    let saved = false;
    try {
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
      complete = true;
      const changedQuota = checkStorageQuota(account);
      if (changedQuota) return changedQuota;
      platformDatabase.prepare(`UPDATE users SET ${imageField}_key=?,${imageField}_size=? WHERE id=?`).run(key, bytes.length, account.id);
      saved = true;
      if (image.imageKey) {
        try { await env.BUCKET.delete(image.imageKey); }
        catch { console.error('Unable to clean up a previous profile image.'); }
      }
      return Response.json({ saved: true });
    } finally {
      profileImageUploads.delete(account.id);
      uploadReservations.set(account.id, (uploadReservations.get(account.id) ?? 0) - reserved);
      if (!saved && complete) {
        try { await env.BUCKET.delete(key); }
        catch { console.error('Unable to clean up an unsuccessful profile image upload.'); }
      }
    }
  }
  if (!path.startsWith('/api/platform/')) return Response.json({ error: '接口不存在。' }, { status: 404 });
  if (account.role !== 'admin') return Response.json({ error: '仅平台管理员可访问。' }, { status: 403 });
  if (path === '/api/platform/accounts' && request.method === 'GET') {
    return Response.json({ accounts: platformDatabase.prepare('SELECT * FROM users ORDER BY created_at DESC,id DESC').all().map(user=>({ ...publicAccount(user), ...accountUsage(user), subscription: getSubscription(user) })), plans: subscriptionPlans });
  }
  if (path === '/api/platform/accounts' && request.method === 'PATCH') {
    const parsed = z.object({ id: z.number().int().positive(), action: z.enum(['enable','disable','trash','restore','quota','configure']), quotaBytes: quotaSchema.optional(), subscriptionPlan: subscriptionPlanSchema.nullable().optional(), subscriptionExpiresAt: subscriptionExpirySchema.nullable().optional() }).safeParse(await request.json());
    if (!parsed.success || (parsed.data.action === 'quota' && parsed.data.quotaBytes === undefined)
      || (parsed.data.action === 'configure' && (parsed.data.quotaBytes === undefined || parsed.data.subscriptionPlan === undefined || parsed.data.subscriptionExpiresAt === undefined
        || (parsed.data.subscriptionPlan === null) !== (parsed.data.subscriptionExpiresAt === null)))) return Response.json({ error: '账户操作无效，请检查套餐、到期时间和容量；分配容量必须大于 0，长期账户的套餐和到期时间均应为空。' }, { status: 400 });
    const { id, action, quotaBytes, subscriptionPlan, subscriptionExpiresAt } = parsed.data;
    const user = platformDatabase.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) return Response.json({ error: '账户不存在。' }, { status: 404 });
    if (user.role === 'admin' && ['disable','trash'].includes(action)) return Response.json({ error: '不能停用或移除平台管理员。' }, { status: 409 });
    if (action === 'configure' || action === 'quota') {
      const addonLimit = Number.MAX_SAFE_INTEGER - quotaBytes;
      let result;
      if (action === 'configure') {
        if (user.role === 'admin' && subscriptionPlan !== null) return Response.json({ error: '平台管理员免订阅，不能设置有限期套餐。' }, { status: 409 });
        result = platformDatabase.prepare(`UPDATE users SET quota_bytes=?,subscription_reminded_on=CASE
          WHEN subscription_plan IS ? AND subscription_expires_at IS ? THEN subscription_reminded_on ELSE NULL END,
          subscription_plan=?,subscription_expires_at=? WHERE id=? AND storage_addon_bytes<=?`)
          .run(quotaBytes,subscriptionPlan,subscriptionExpiresAt,subscriptionPlan,subscriptionExpiresAt,id,addonLimit);
      } else {
        result = platformDatabase.prepare('UPDATE users SET quota_bytes=? WHERE id=? AND storage_addon_bytes<=?').run(quotaBytes,id,addonLimit);
      }
      if (result.changes === 0) return Response.json({ error: '基础容量与已兑换扩容的总和超出支持范围。' }, { status: 409 });
    }
    if (action === 'enable') platformDatabase.prepare('UPDATE users SET is_active=1 WHERE id=? AND deleted_at IS NULL').run(id);
    if (action === 'disable') platformDatabase.prepare('UPDATE users SET is_active=0 WHERE id=?').run(id);
    if (action === 'trash') platformDatabase.prepare('UPDATE users SET deleted_at=?,is_active=0 WHERE id=?').run(new Date().toISOString(),id);
    if (action === 'restore') platformDatabase.prepare('UPDATE users SET deleted_at=NULL,is_active=1 WHERE id=?').run(id);
    if (['disable','trash'].includes(action)) platformDatabase.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    return Response.json({ saved: true });
  }
  if (path === '/api/platform/invitations' && request.method === 'GET') {
    const parsed=z.coerce.number().int().min(1).safeParse(new URL(request.url).searchParams.get('page') ?? 1);
    if(!parsed.success)return Response.json({error:'页码无效。'},{status:400});
    const total=platformDatabase.prepare('SELECT COUNT(*) AS count FROM invitations').get().count;
    const page=Math.min(parsed.data,Math.max(1,Math.ceil(total/50)));
    const rows = platformDatabase.prepare(`SELECT invitations.id,invitations.hint,invitations.note,invitations.quota_bytes AS quotaBytes,invitations.add_on_bytes AS addOnBytes,invitations.subscription_plan AS planId,invitations.duration_days AS durationDays,invitations.grants_permanent AS permanent,invitations.created_at AS createdAt,invitations.expires_at AS expiresAt,invitations.revoked_at AS revokedAt,invitations.used_at AS usedAt,users.login_id AS usedBy
      FROM invitations LEFT JOIN users ON users.id=invitations.used_by ORDER BY invitations.created_at DESC,invitations.id LIMIT 50 OFFSET ?`).all((page-1)*50);
    return Response.json({ invitations: rows.map(row => ({ ...row, permanent: row.permanent === 1 })), plans: subscriptionPlans, defaultQuotaBytes, page, total });
  }
  if (path === '/api/platform/invitations' && request.method === 'POST') {
    const parsed = z.object({
      count: z.number().int().min(1).max(50), days: z.number().int().min(0).max(90), note: z.string().trim().max(80),
      quotaBytes: quotaSchema.optional(), addOnBytes: quotaSchema.optional(), durationDays: durationDaysSchema.optional(),
      planId: subscriptionPlanSchema.optional(), permanent: z.boolean().default(false),
    }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '请检查数量、兑换期限、订阅天数、套餐、容量和备注。' }, { status: 400 });
    const { count, days, quotaBytes, addOnBytes, durationDays, note, planId, permanent } = parsed.data;
    if (addOnBytes !== undefined) {
      if (planId !== undefined || permanent || durationDays !== undefined || quotaBytes !== undefined) {
        return Response.json({ error: '扩容码只增加容量，不能同时设置套餐、订阅天数或基础容量。' }, { status: 400 });
      }
    } else if ((!planId && (quotaBytes === undefined || durationDays !== undefined)) || (permanent && planId !== undefined)) {
      return Response.json({ error: '请选择有效套餐和订阅天数，长期有效码需单独选择并填写正容量。' }, { status: 400 });
    }
    if (planId) return Response.json(createSubscriptionCodes({ planId, count, validityDays: days, durationDays, quotaBytes, createdBy: account.id, note }), { status: 201 });
    const now = Date.now();
    const expiresAt = days ? now + days * 86400000 : null;
    const codes = [];
    platformDatabase.exec('BEGIN IMMEDIATE');
    try {
      if (addOnBytes !== undefined) {
        for (let index = 0; index < count; index++) {
          codes.push(insertStorageAddonCode({ addOnBytes, expiresAt, createdBy: account.id, note, now }).code);
        }
      } else {
        const insert = platformDatabase.prepare('INSERT INTO invitations (id,token_hash,hint,note,quota_bytes,created_by,created_at,expires_at,grants_permanent) VALUES (?,?,?,?,?,?,?,?,?)');
        for (let index = 0; index < count; index++) {
          const code = `YY-${randomBytes(18).toString('base64url')}`;
          insert.run(randomUUID(),createHash('sha256').update(code).digest('hex'),`${code.slice(0,7)}…${code.slice(-4)}`,note,quotaBytes,account.id,new Date(now).toISOString(),expiresAt,Number(permanent));
          codes.push(code);
        }
      }
      platformDatabase.exec('COMMIT');
    } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
    if (addOnBytes !== undefined) return Response.json({ codes, addOnBytes }, { status: 201 });
    return Response.json(permanent ? { codes, plan: { id: 'permanent', name: '长期有效', days: null, quotaBytes, permanent: true } } : { codes }, { status: 201 });
  }
  if (path === '/api/platform/invitations' && request.method === 'DELETE') {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: '邀请码信息无效。' }, { status: 400 });
    const result = platformDatabase.prepare('UPDATE invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').run(new Date().toISOString(),parsed.data.id);
    return result.changes ? Response.json({ revoked: true }) : Response.json({ error: '邀请码已使用、已撤销或不存在。' }, { status: 409 });
  }
  if (path === '/api/platform/overview' && request.method === 'GET') {
    const users = platformDatabase.prepare('SELECT * FROM users').all();
    const usage = users.map(user=>accountUsage(user));
    const disk = await statfs(dataDirectory);
    let availableMemory = freemem();
    let network = null;
    if (process.platform === 'linux') {
      const memory = await readFile('/proc/meminfo','utf8');
      availableMemory = Number(memory.match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024;
      const interfaces = new Set(Object.entries(networkInterfaces()).filter(([,addresses])=>addresses.some(address=>!address.internal)).map(([name])=>name));
      network = { receivedBytes: 0, sentBytes: 0 };
      for (const line of (await readFile('/proc/net/dev','utf8')).split('\n').slice(2)) {
        const [name, counters] = line.split(':');
        if (!interfaces.has(name.trim())) continue;
        const values = counters.trim().split(/\s+/).map(Number);
        network.receivedBytes += values[0]; network.sentBytes += values[8];
      }
    }
    return Response.json({
      storageBackend,
      accountCount: users.filter(user=>!user.deleted_at).length,
      activeAccountCount: users.filter(user=>user.is_active && !user.deleted_at).length,
      photoCount: usage.reduce((sum,item)=>sum+item.photoCount,0),
      storageBytes: usage.reduce((sum,item)=>sum+item.storageBytes,0),
      storageComplete: usage.every(item=>item.storageComplete),
      pendingBytes: usage.reduce((sum,item)=>sum+item.pendingBytes,0),
      system: { totalMemoryBytes: totalmem(), usedMemoryBytes: totalmem()-availableMemory, appMemoryBytes: process.memoryUsage().rss, totalDiskBytes: disk.blocks*disk.bsize, usedDiskBytes: (disk.blocks-disk.bfree)*disk.bsize, uptimeSeconds: uptime(), network },
      cloudTraffic: { available: false, explanation: storageBackend === 'local' ? '本地模式的照片由服务器磁盘提供。网卡数据表示服务器自身累计收发量，CDN 等外部服务的用量需单独核对。' : 'COS 与 EdgeOne 的云端用量尚未接入。网卡数据表示服务器自身累计收发量，不能代替云产品账单。' },
    });
  }
  return Response.json({ error: '接口或请求方式无效。' }, { status: 404 });
}

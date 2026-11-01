import { z } from 'zod';
import { checkAdmin } from './auth.mjs';
import { getDatabase } from './database.mjs';
import { cos, bucketParameters, env, signedUrl } from './storage.mjs';
import { PATCH as saveUpload } from '../../app/api/admin/uploads/route.ts';
import { POST as createUpload } from '../../app/api/admin/uploads/route.ts';
import { getCurrentAccount, getSqlite } from './database.mjs';
import { checkStorageQuota, uploadReservations } from './platform-api.mjs';

export async function startUpload(request) {
  const denied = await checkAdmin(request);
  if (denied) return denied;
  const parsed = z.object({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(await request.clone().json());
  if (!parsed.success) return Response.json({ error: '照片大小无效。' }, { status: 400 });
  const account = getCurrentAccount();
  const quotaDenied = checkStorageQuota(account,parsed.data.size);
  if (quotaDenied) return quotaDenied;
  uploadReservations.set(account.id, (uploadReservations.get(account.id) ?? 0) + parsed.data.size);
  try { return await createUpload(request); }
  finally { uploadReservations.set(account.id, uploadReservations.get(account.id) - parsed.data.size); }
}

export async function uploadPart(request) {
  const denied = await checkAdmin(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const parsed = z.object({ id: z.string().uuid(), part: z.coerce.number().int().min(1).max(10000) }).safeParse({ id: query.get('id'), part: query.get('part') });
  if (!parsed.success) return Response.json({ error: '分块信息无效。' }, { status: 400 });
  const upload = await getDatabase().prepare('SELECT upload_id AS uploadId, image_key AS imageKey, size FROM photo_uploads WHERE id = ?').bind(parsed.data.id).first();
  if (!upload) return Response.json({ error: '上传任务不存在。' }, { status: 404 });
  const partSize = 8 * 1024 * 1024;
  if ((parsed.data.part - 1) * partSize >= upload.size) return Response.json({ error: '分块编号超出照片大小。' }, { status: 400 });
  const quotaDenied = checkStorageQuota(getCurrentAccount());
  if (quotaDenied) return quotaDenied;
  const expectedSize = Math.min(partSize,upload.size - (parsed.data.part - 1) * partSize);
  if (request.method === 'GET') return Response.json({ url: await signedUrl(upload.imageKey, { Method: 'PUT', Headers: { 'content-length': String(expectedSize) }, Query: { uploadId: upload.uploadId, partNumber: String(parsed.data.part) } }) }, { headers: { 'Cache-Control': 'private, no-store' } });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length !== expectedSize) return Response.json({ error: '照片分块大小与上传信息不一致，请重试。' }, { status: 400 });
  const result = await cos.multipartUpload({ ...bucketParameters, Key: upload.imageKey, UploadId: upload.uploadId, PartNumber: parsed.data.part, Body: bytes });
  if (!result.ETag) throw new Error('The uploaded part has no ETag.');
  return Response.json({ etag: result.ETag }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function finishUpload(request) {
  const denied = await checkAdmin(request);
  if (denied) return denied;
  const parsed = z.object({ id: z.string().uuid(), parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })).min(1).max(10000) }).safeParse(await request.clone().json());
  if (!parsed.success) return Response.json({ error: '上传完成信息无效。' }, { status: 400 });
  const { id, parts } = parsed.data;
  const upload = await getDatabase().prepare('SELECT upload_id AS uploadId, image_key AS imageKey, content_type AS contentType, size FROM photo_uploads WHERE id = ?').bind(id).first();
  if (!upload) return saveUpload(request);
  if (parts.length !== Math.ceil(upload.size / (8 * 1024 * 1024)) || parts.some((part, index) => part.partNumber !== index + 1)) return Response.json({ error: '还有分块未上传完成。' }, { status: 400 });
  const quotaDenied = checkStorageQuota(getCurrentAccount());
  if (quotaDenied) return quotaDenied;
  const object = await env.BUCKET.head(upload.imageKey) ?? await env.BUCKET.resumeMultipartUpload(upload.imageKey, upload.uploadId).complete(parts);
  if (object.size !== upload.size) return Response.json({ error: '照片大小与上传信息不一致，请取消后重传。' }, { status: 400 });
  const { Body: bytes } = await cos.getObject({ ...bucketParameters, Key: upload.imageKey, Range: `bytes=0-${Math.min(15, upload.size - 1)}` });
  const valid = upload.contentType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : upload.contentType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    : upload.contentType === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
    : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  if (!valid) return Response.json({ error: '图片实际格式与文件类型不符，请取消后重新选择照片。' }, { status: 415 });
  const changedQuota = checkStorageQuota(getCurrentAccount());
  if (changedQuota) return changedQuota;
  getSqlite().prepare('INSERT OR REPLACE INTO object_sizes VALUES (?,?)').run(id, upload.size);
  return saveUpload(request);
}

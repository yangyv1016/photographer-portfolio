import { env } from "cloudflare:workers";
import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";
import type { photoUploads } from "../../../../db/schema";

export const dynamic = "force-dynamic";
const partSize = 8 * 1024 * 1024;
const formats = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as const;
const createSchema = z.object({
  series: z.string().min(1), title: z.string().trim().min(1).max(120),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  size: z.number().int().positive().max(partSize * 10000),
});
const finishSchema = z.object({
  id: z.string().uuid(),
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })).min(1).max(10000),
});
type UploadRow = typeof photoUploads.$inferSelect;
const uploadColumns = "id, upload_id AS uploadId, image_key AS imageKey, series, title, content_type AS contentType, size, created_at AS createdAt";

export async function POST(request: Request) {
  let multipart: R2MultipartUpload | undefined;
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请选择有效的 JPG、PNG、WebP 或 GIF，并填写标题和系列。" }, { status: 400 });
    const body = parsed.data;
    const database = getDatabase();
    if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(body.series).first()) return Response.json({ error: "所选系列不存在，请刷新后重试。" }, { status: 400 });
    if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
    const id = crypto.randomUUID();
    const key = `photos/${id}.${formats[body.contentType]}`;
    multipart = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType } });
    await database.prepare("INSERT INTO photo_uploads (id, upload_id, image_key, series, title, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, multipart.uploadId, key, body.series, body.title, body.contentType, body.size, new Date().toISOString()).run();
    return Response.json({ id, partSize }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (multipart) {
      try { await multipart.abort(); } catch (cleanupError) { console.error("Unable to abort unregistered upload", cleanupError); }
    }
    if (error instanceof SyntaxError) return Response.json({ error: "上传信息格式无效。" }, { status: 400 });
    console.error("Unable to start photo upload", error);
    return Response.json({ error: "无法开始上传，请稍后重试。" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const query = new URL(request.url).searchParams;
    const parsed = z.object({ id: z.string().uuid(), part: z.coerce.number().int().min(1).max(10000) }).safeParse({ id: query.get("id"), part: query.get("part") });
    if (!parsed.success) return Response.json({ error: "分块信息无效，请重新添加照片。" }, { status: 400 });
    const upload = await getDatabase().prepare(`SELECT ${uploadColumns} FROM photo_uploads WHERE id = ?`).bind(parsed.data.id).first<UploadRow>();
    if (!upload) return Response.json({ error: "上传任务不存在，请重新添加照片。" }, { status: 404 });
    const expectedSize = Math.min(partSize, upload.size - (parsed.data.part - 1) * partSize);
    if (expectedSize <= 0 || Number(request.headers.get("content-length")) !== expectedSize) return Response.json({ error: "分块大小不正确，请重试。" }, { status: 400 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== expectedSize) return Response.json({ error: "分块传输不完整，请重试。" }, { status: 400 });
    if (parsed.data.part === 1) {
      const decoder = new TextDecoder();
      const valid = upload.contentType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : upload.contentType === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
        : upload.contentType === "image/webp" ? decoder.decode(bytes.slice(0, 4)) === "RIFF" && decoder.decode(bytes.slice(8, 12)) === "WEBP"
        : ["GIF87a", "GIF89a"].includes(decoder.decode(bytes.slice(0, 6)));
      if (!valid) return Response.json({ error: "图片实际格式与文件类型不符，请使用 JPG、PNG、WebP 或 GIF。" }, { status: 415 });
    }
    if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
    const part = await env.BUCKET.resumeMultipartUpload(upload.imageKey, upload.uploadId).uploadPart(parsed.data.part, bytes);
    return Response.json(part, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Unable to upload photo part", error);
    return Response.json({ error: "当前分块上传失败，可重试继续。" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = finishSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "上传完成信息无效。" }, { status: 400 });
    const { id, parts } = parsed.data;
    const database = getDatabase();
    const upload = await database.prepare(`SELECT ${uploadColumns} FROM photo_uploads WHERE id = ?`).bind(id).first<UploadRow>();
    if (!upload) {
      if (await database.prepare("SELECT id FROM photos WHERE id = ?").bind(id).first()) return Response.json({ id });
      return Response.json({ error: "上传任务不存在，请重新添加照片。" }, { status: 404 });
    }
    if (parts.length !== Math.ceil(upload.size / partSize) || parts.some((part, index) => part.partNumber !== index + 1)) return Response.json({ error: "还有分块未上传完成，请继续上传。" }, { status: 400 });
    if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(upload.series).first()) return Response.json({ error: "所选系列已不存在，请重新选择系列。" }, { status: 400 });
    if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
    // A completed object may already exist if the preceding database write failed.
    const object = await env.BUCKET.head(upload.imageKey) ?? await env.BUCKET.resumeMultipartUpload(upload.imageKey, upload.uploadId).complete(parts);
    if (object.size !== upload.size) throw new Error("Completed photo size differs from upload metadata.");
    await database.batch([
      database.prepare(`INSERT INTO photos (id, series, title, alt, src, image_key, photographer, is_sample, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '旸隅', 0, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM photos WHERE series = ?), ?)`)
        .bind(id, upload.series, upload.title, upload.title, `/api/media/${id}`, upload.imageKey, upload.series, new Date().toISOString()),
      database.prepare("DELETE FROM photo_uploads WHERE id = ?").bind(id),
    ]);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "上传完成信息格式无效。" }, { status: 400 });
    console.error("Unable to finish photo upload", error);
    return Response.json({ error: "照片尚未保存，可点击上传继续完成。" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = z.object({ id: z.string().uuid() }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "上传任务信息无效。" }, { status: 400 });
    const database = getDatabase();
    const upload = await database.prepare(`SELECT ${uploadColumns} FROM photo_uploads WHERE id = ?`).bind(parsed.data.id).first<UploadRow>();
    if (upload) {
      if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
      if (await env.BUCKET.head(upload.imageKey)) await env.BUCKET.delete(upload.imageKey);
      else await env.BUCKET.resumeMultipartUpload(upload.imageKey, upload.uploadId).abort();
      await database.prepare("DELETE FROM photo_uploads WHERE id = ?").bind(upload.id).run();
    }
    return Response.json({ cancelled: true });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "上传任务信息格式无效。" }, { status: 400 });
    console.error("Unable to cancel photo upload", error);
    return Response.json({ error: "未能取消上传任务，请重试。" }, { status: 503 });
  }
}

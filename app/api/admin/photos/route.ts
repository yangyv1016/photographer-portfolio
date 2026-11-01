import { env } from "cloudflare:workers";
import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";
import { getGalleryPhotos, type PhotoRow } from "../../../../db/gallery";
import { getSeries } from "../../../../db/series";

export const dynamic = "force-dynamic";
const editSchema = z.object({
  id: z.string().min(1), title: z.string().trim().min(1).max(120),
  alt: z.string().trim().max(300), series: z.string().min(1),
  showOnWall: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const [photos, series] = await Promise.all([getGalleryPhotos(), getSeries()]);
    return Response.json({ photos, series }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Unable to load admin photos", error);
    return Response.json({ error: "照片库暂时不可用，请稍后重试。" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = editSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请检查标题、图片描述、系列和照片墙设置。" }, { status: 400 });
    const body = parsed.data;
    const database = getDatabase();
    if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(body.series).first()) return Response.json({ error: "所选系列不存在，请刷新后重试。" }, { status: 400 });
    const photo = await database.prepare("SELECT id, series FROM photos WHERE id = ?").bind(body.id).first<Pick<PhotoRow, "id" | "series">>();
    if (!photo) return Response.json({ error: "这张照片已被删除，请刷新照片库。" }, { status: 404 });
    await database.prepare(`UPDATE photos SET title = ?, alt = ?, series = ?, show_on_wall = COALESCE(?, show_on_wall),
      sort_order = CASE WHEN series = ? THEN sort_order ELSE (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM photos WHERE series = ?) END
      WHERE id = ?`).bind(body.title, body.alt, body.series, body.showOnWall === undefined ? null : Number(body.showOnWall), body.series, body.series, body.id).run();
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to update photo", error);
    return Response.json({ error: "修改未保存，请保留内容并重试。" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请选择要删除的照片。" }, { status: 400 });
    const database = getDatabase();
    const photo = await database.prepare("SELECT image_key AS imageKey FROM photos WHERE id = ?").bind(parsed.data.id).first<Pick<PhotoRow, "imageKey">>();
    if (!photo) return Response.json({ error: "这张照片已被删除。" }, { status: 404 });
    if (photo.imageKey) {
      if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
      await env.BUCKET.delete(photo.imageKey);
    }
    await database.prepare("DELETE FROM photos WHERE id = ?").bind(parsed.data.id).run();
    return Response.json({ deleted: true });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to delete photo", error);
    return Response.json({ error: "删除未完成，请刷新照片库后重试。" }, { status: 503 });
  }
}

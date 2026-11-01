import { env } from "cloudflare:workers";
import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";
import type { PhotoRow } from "../../../../db/gallery";

const idsSchema = z.array(z.string().min(1)).min(1).max(100);
const batchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), ids: idsSchema, series: z.string().min(1) }),
  z.object({ action: z.literal("delete"), ids: idsSchema }),
]);

export async function POST(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = batchSchema.safeParse(await request.json());
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      return Response.json({ error: "请选择有效照片和批量操作。" }, { status: 400 });
    }
    const body = parsed.data;
    const database = getDatabase();
    const placeholders = body.ids.map(() => "?").join(",");
    const current = await database.prepare(`SELECT id, series, image_key AS imageKey FROM photos WHERE id IN (${placeholders}) ORDER BY series, sort_order, created_at, id`)
      .bind(...body.ids).all<Pick<PhotoRow, "id" | "series" | "imageKey">>();
    if (current.results.length !== body.ids.length) {
      return Response.json({ error: "所选照片已发生变化，请刷新照片库后重试。" }, { status: 409 });
    }
    if (body.action === "move") {
      if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(body.series).first()) return Response.json({ error: "所选系列不存在，请刷新后重试。" }, { status: 400 });
      const moving = current.results.filter(photo => photo.series !== body.series);
      if (moving.length) await database.batch(moving.map(photo => database.prepare(`UPDATE photos SET series = ?,
        sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM photos WHERE series = ?) WHERE id = ?`)
        .bind(body.series, body.series, photo.id)));
    } else {
      const keys = current.results.flatMap(photo => photo.imageKey ? [photo.imageKey] : []);
      if (keys.length) {
        if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
        await env.BUCKET.delete(keys);
      }
      await database.batch(body.ids.map(id => database.prepare("DELETE FROM photos WHERE id = ?").bind(id)));
    }
    return Response.json({ processed: body.ids.length });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to apply batch photo operation", error);
    return Response.json({ error: "批量操作未完成，请刷新照片库后重试。" }, { status: 503 });
  }
}

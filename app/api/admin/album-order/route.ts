import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";

const orderSchema = z.object({ series: z.string().min(1).optional(), ids: z.array(z.string().min(1)) });

export async function POST(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = orderSchema.safeParse(await request.json());
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      return Response.json({ error: "相册顺序无效，请刷新后重试。" }, { status: 400 });
    }
    const { ids, series } = parsed.data;
    const database = getDatabase();
    if (series !== undefined && !await database.prepare("SELECT id FROM series WHERE id = ?").bind(series).first()) {
      return Response.json({ error: "所选系列不存在，请刷新后重试。" }, { status: 400 });
    }
    const query = database.prepare(`SELECT id, album_order AS albumOrder FROM photos${series === undefined ? "" : " WHERE series = ?"} ORDER BY album_order, created_at, id`);
    const current = await (series === undefined ? query : query.bind(series)).all<{ id: string; albumOrder: number }>();
    const currentIds = new Set(current.results.map(photo => photo.id));
    if (ids.length !== currentIds.size || ids.some(id => !currentIds.has(id))) {
      return Response.json({ error: "照片库已变化，请刷新后再调整相册顺序。" }, { status: 409 });
    }
    // A filtered series keeps its existing global slots; other photos keep their positions.
    if (ids.length) await database.batch(ids.map((id, index) => database.prepare("UPDATE photos SET album_order = ? WHERE id = ?")
      .bind(series === undefined ? index : current.results[index].albumOrder, id)));
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to save album order", error);
    return Response.json({ error: "相册排序未保存，请稍后重试。" }, { status: 503 });
  }
}

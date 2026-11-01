import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";

const orderSchema = z.object({ series: z.string().min(1), ids: z.array(z.string().min(1)) });

export async function POST(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = orderSchema.safeParse(await request.json());
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      return Response.json({ error: "照片顺序无效，请刷新后重试。" }, { status: 400 });
    }
    const { ids, series } = parsed.data;
    const database = getDatabase();
    if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(series).first()) return Response.json({ error: "所选系列不存在，请刷新后重试。" }, { status: 400 });
    const current = await database.prepare("SELECT id FROM photos WHERE series = ?").bind(series).all<{ id: string }>();
    const currentIds = new Set(current.results.map(photo => photo.id));
    if (ids.length !== currentIds.size || ids.some(id => !currentIds.has(id))) {
      return Response.json({ error: "照片库已变化，请刷新后再调整顺序。" }, { status: 409 });
    }
    if (ids.length) await database.batch(ids.map((id, index) => database.prepare("UPDATE photos SET sort_order = ? WHERE id = ? AND series = ?").bind(index, id, series)));
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to save photo order", error);
    return Response.json({ error: "排序未保存，请稍后重试。" }, { status: 503 });
  }
}

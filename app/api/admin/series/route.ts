import { z } from "zod";
import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";
import { getSeries, initializeSeries } from "../../../../db/series";

const seriesSchema = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(200) });

export async function POST(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = seriesSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "系列名称需为 1–40 字，简介不超过 200 字。" }, { status: 400 });
    await initializeSeries();
    const database = getDatabase();
    const duplicate = await database.prepare("SELECT id FROM series WHERE name = ?").bind(parsed.data.name).first();
    if (duplicate) return Response.json({ error: "已有同名系列，请换一个名称。" }, { status: 409 });
    const id = crypto.randomUUID();
    await database.prepare(`INSERT INTO series (id, name, description, sort_order, created_at)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM series), ?)`)
      .bind(id, parsed.data.name, parsed.data.description, new Date().toISOString()).run();
    return Response.json({ id, series: await getSeries() }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to create photo series", error);
    return Response.json({ error: "系列未保存，请保留内容并重试。" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = seriesSchema.extend({ id: z.string().min(1) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请检查系列名称和简介。" }, { status: 400 });
    await initializeSeries();
    const database = getDatabase();
    const current = await database.prepare("SELECT id FROM series WHERE id = ?").bind(parsed.data.id).first();
    if (!current) return Response.json({ error: "找不到这个系列，请刷新后重试。" }, { status: 404 });
    const duplicate = await database.prepare("SELECT id FROM series WHERE name = ? AND id <> ?").bind(parsed.data.name, parsed.data.id).first();
    if (duplicate) return Response.json({ error: "已有同名系列，请换一个名称。" }, { status: 409 });
    await database.prepare("UPDATE series SET name = ?, description = ? WHERE id = ?").bind(parsed.data.name, parsed.data.description, parsed.data.id).run();
    return Response.json({ series: await getSeries() });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to edit photo series", error);
    return Response.json({ error: "修改未保存，请保留内容并重试。" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1) }).safeParse(await request.json());
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) return Response.json({ error: "系列顺序无效。" }, { status: 400 });
    await initializeSeries();
    const current = await getSeries();
    const currentIds = new Set(current.map(series => series.id));
    if (parsed.data.ids.length !== current.length || parsed.data.ids.some(id => !currentIds.has(id))) return Response.json({ error: "系列列表已变化，请刷新后重试。" }, { status: 409 });
    const database = getDatabase();
    await database.batch(parsed.data.ids.map((id, index) => database.prepare("UPDATE series SET sort_order = ? WHERE id = ?").bind(index, id)));
    return Response.json({ series: await getSeries() });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to reorder photo series", error);
    return Response.json({ error: "系列顺序未保存，请稍后重试。" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    const parsed = z.object({ id: z.string().min(1), moveTo: z.string().min(1).optional() }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请选择要删除的系列。" }, { status: 400 });
    const { id, moveTo } = parsed.data;
    if (moveTo === id) return Response.json({ error: "请选择另一个系列接收照片。" }, { status: 400 });
    await initializeSeries();
    const database = getDatabase();
    if (!await database.prepare("SELECT id FROM series WHERE id = ?").bind(id).first()) return Response.json({ error: "这个系列已不存在，请刷新后重试。" }, { status: 404 });
    const { results: [counts] } = await database.prepare(`SELECT
      (SELECT COUNT(*) FROM photos WHERE series = ?) AS photoCount,
      (SELECT COUNT(*) FROM photo_uploads WHERE series = ?) AS uploadCount`).bind(id, id).all<{ photoCount: number; uploadCount: number }>();
    if ((counts.photoCount || counts.uploadCount) && !moveTo) return Response.json({ error: "这个系列还有照片或上传任务，请先选择移入的系列。" }, { status: 409 });
    if (moveTo && !await database.prepare("SELECT id FROM series WHERE id = ?").bind(moveTo).first()) return Response.json({ error: "接收照片的系列不存在，请刷新后重试。" }, { status: 400 });
    const statements: D1PreparedStatement[] = [];
    if (moveTo) {
      statements.push(database.prepare(`WITH moving AS MATERIALIZED (
        SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at, id) AS position FROM photos WHERE series = ?
      ), destination AS MATERIALIZED (
        SELECT COALESCE(MAX(sort_order), -1) AS last_order FROM photos WHERE series = ?
      ) UPDATE photos SET series = ?,
        sort_order = (SELECT last_order FROM destination) + (SELECT position FROM moving WHERE moving.id = photos.id)
        WHERE series = ? AND EXISTS (SELECT 1 FROM series WHERE id = ?)`)
        .bind(id, moveTo, moveTo, id, moveTo));
      statements.push(database.prepare("UPDATE photo_uploads SET series = ? WHERE series = ? AND EXISTS (SELECT 1 FROM series WHERE id = ?)").bind(moveTo, id, moveTo));
    }
    statements.push(database.prepare(`DELETE FROM series WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM photos WHERE series = ?)
      AND NOT EXISTS (SELECT 1 FROM photo_uploads WHERE series = ?)`).bind(id, id, id));
    const result = await database.batch(statements);
    if (result[result.length - 1].meta.changes !== 1) return Response.json({ error: "系列内容已发生变化，请刷新后重新选择接收系列。" }, { status: 409 });
    return Response.json({ deleted: true, moved: moveTo ? result[0].meta.changes : 0, series: await getSeries() });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "提交内容格式无效。" }, { status: 400 });
    console.error("Unable to delete photo series", error);
    return Response.json({ error: "系列未删除，请刷新后重试。" }, { status: 503 });
  }
}

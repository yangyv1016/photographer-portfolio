import { checkAdmin } from "../../../admin-access";
import { getDatabase } from "../../../../db/index";
import { samples } from "../../../../db/sample-photos";
import { initializeSeries } from "../../../../db/series";

export async function POST(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied) return denied;
    await initializeSeries();
    const database = getDatabase();
    const statements = samples.map((photo, index) => database.prepare(`
      INSERT INTO photos (id, series, title, alt, src, photographer, source, license,
        license_url, is_sample, sort_order, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'gallery_initialized')
    `).bind(`sample-${index + 1}`, photo.series, photo.title, photo.alt, photo.src,
      photo.photographer, photo.source, photo.license, photo.licenseUrl, index, new Date().toISOString()));
    statements.push(database.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('gallery_initialized', '1')"));
    await database.batch(statements);
    return Response.json({ initialized: true });
  } catch (error) {
    console.error("Unable to initialize photo gallery", error);
    return Response.json({ error: "照片库暂时不可用，请稍后重试。" }, { status: 503 });
  }
}

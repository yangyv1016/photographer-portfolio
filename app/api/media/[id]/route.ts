import { env } from "cloudflare:workers";
import { getDatabase } from "../../../../db/index";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const photo = await getDatabase().prepare("SELECT image_key AS imageKey FROM photos WHERE id = ?").bind(id).first<{ imageKey: string | null }>();
    if (!photo?.imageKey) return new Response("Photo not found", { status: 404 });
    if (!env.BUCKET) throw new Error("Photo storage binding BUCKET is unavailable.");
    const image = await env.BUCKET.get(photo.imageKey);
    if (!image) return new Response("Photo not found", { status: 404 });
    const headers = new Headers();
    image.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("ETag", image.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(image.body, { headers });
  } catch (error) {
    console.error("Unable to read uploaded photo", error);
    return new Response("照片暂时无法加载", { status: 503 });
  }
}

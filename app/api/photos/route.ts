import { getGalleryPhotos } from "../../../db/gallery";
import { getSeries } from "../../../db/series";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const [photos, series] = await Promise.all([getGalleryPhotos(), getSeries()]);
    return Response.json({ photos, series }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to load portfolio photos", error);
    return Response.json({ error: "照片暂时无法加载，请稍后重试。" }, { status: 503 });
  }
}

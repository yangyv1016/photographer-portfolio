import { renderAlbum } from "../album";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return renderAlbum(undefined, { selectedSeriesId: new URL(request.url).searchParams.get("series") ?? "" });
}

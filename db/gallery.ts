import { getDatabase } from "./index";
import { samples } from "./sample-photos";
import type { photos } from "./schema";

export type PhotoRow = typeof photos.$inferSelect;
export const photoColumns = `id, series, title, alt, src, image_key AS imageKey,
  photographer, source, license, license_url AS licenseUrl,
  is_sample AS isSample, show_on_wall AS showOnWall, album_order AS albumOrder,
  sort_order AS sortOrder, created_at AS createdAt`;

export async function getGalleryPhotos() {
  const database = getDatabase();
  const initialized = await database.prepare("SELECT value FROM settings WHERE key = 'gallery_initialized'").first();
  if (!initialized) return samples.map((photo, index) => ({
    ...photo, id: `sample-${index + 1}`, isSample: true, showOnWall: true, albumOrder: index,
    sortOrder: index, thumbnailSrc: photo.src,
  }));
  const result = await database.prepare(`SELECT ${photoColumns} FROM photos ORDER BY series, sort_order, created_at, id`).all<PhotoRow>();
  return result.results.map(photo => ({ ...photo, isSample: photo.isSample === 1, showOnWall: photo.showOnWall === 1, thumbnailSrc: photo.src }));
}

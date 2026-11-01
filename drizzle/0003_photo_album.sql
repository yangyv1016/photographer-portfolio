ALTER TABLE `photos` ADD `show_on_wall` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `album_order` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_photos_album_order` ON `photos` (`album_order`);
--> statement-breakpoint
WITH ranked AS (
  SELECT photos.id, ROW_NUMBER() OVER (
    ORDER BY COALESCE(series.sort_order, 0), photos.series, photos.sort_order, photos.created_at, photos.id
  ) - 1 AS position
  FROM photos LEFT JOIN series ON series.id = photos.series
)
UPDATE photos SET album_order = (SELECT position FROM ranked WHERE ranked.id = photos.id);
--> statement-breakpoint
-- Keep every insert path, including uploads and sample initialization, at the end of the album.
CREATE TRIGGER `append_photo_album_order` AFTER INSERT ON `photos`
WHEN NEW.album_order = -1
BEGIN
  UPDATE photos SET album_order = (
    SELECT COALESCE(MAX(album_order), -1) + 1 FROM photos WHERE id <> NEW.id
  ) WHERE id = NEW.id;
END;

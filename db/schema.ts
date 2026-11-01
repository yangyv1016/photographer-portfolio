import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const photoSeries = sqliteTable("series", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("idx_series_name").on(table.name)]);

export const photos = sqliteTable("photos", {
  id: text("id").primaryKey(),
  series: text("series").notNull(),
  title: text("title").notNull(),
  alt: text("alt").notNull(),
  src: text("src").notNull(),
  imageKey: text("image_key"),
  photographer: text("photographer").notNull(),
  source: text("source"),
  license: text("license"),
  licenseUrl: text("license_url"),
  isSample: integer("is_sample").notNull().default(0),
  showOnWall: integer("show_on_wall").notNull().default(1),
  albumOrder: integer("album_order").notNull().default(-1),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [
  index("idx_photos_series_order").on(table.series, table.sortOrder),
  index("idx_photos_album_order").on(table.albumOrder),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const photoUploads = sqliteTable("photo_uploads", {
  id: text("id").primaryKey(),
  uploadId: text("upload_id").notNull(),
  imageKey: text("image_key").notNull(),
  series: text("series").notNull(),
  title: text("title").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
});

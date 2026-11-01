CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`series` text NOT NULL,
	`title` text NOT NULL,
	`alt` text NOT NULL,
	`src` text NOT NULL,
	`image_key` text,
	`photographer` text NOT NULL,
	`source` text,
	`license` text,
	`license_url` text,
	`is_sample` integer DEFAULT 0 NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_photos_series_order` ON `photos` (`series`,`sort_order`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

CREATE TABLE `photo_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`image_key` text NOT NULL,
	`series` text NOT NULL,
	`title` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);

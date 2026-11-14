CREATE TABLE `capture_image_uploads` (
	`capture_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`write_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`upload_id` text,
	`sha256` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`original_filename` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `capture_image_uploads_pk` PRIMARY KEY(`capture_id`, `sort_order`),
	CONSTRAINT `fk_capture_image_uploads_capture_id_bottle_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `bottle_captures`(`id`)
);
--> statement-breakpoint
ALTER TABLE `r2_object_deletion_queue` ADD `multipart_upload_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `image_assets_site_id_sha256_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `capture_image_uploads_write_id_unique` ON `capture_image_uploads` (`write_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `capture_image_uploads_r2_key_unique` ON `capture_image_uploads` (`r2_key`);
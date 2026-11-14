CREATE TABLE `addition_receipts` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`operation_id` text NOT NULL,
	`site_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `addition_receipts_pk` PRIMARY KEY(`user_id`, `kind`, `operation_id`)
);

CREATE TABLE `review_run_retries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_run_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`review_run_id`) REFERENCES `review_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_run_retries_created_at_idx` ON `review_run_retries` (`created_at`);--> statement-breakpoint
CREATE INDEX `review_run_retries_review_run_id_idx` ON `review_run_retries` (`review_run_id`);
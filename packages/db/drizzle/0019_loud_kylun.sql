CREATE TABLE `runner_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`review_run_id` integer NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`github_repository_id` integer NOT NULL,
	`pull_request_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`request` text NOT NULL,
	`status` text NOT NULL,
	`github_run_id` text,
	`github_run_attempt` text,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`review_run_id`) REFERENCES `review_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runner_jobs_status_check" CHECK("runner_jobs"."status" in ('issued', 'claimed', 'completed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_jobs_review_run_id_unique` ON `runner_jobs` (`review_run_id`);--> statement-breakpoint
CREATE INDEX `runner_jobs_lookup_idx` ON `runner_jobs` (`github_repository_id`,`pull_request_number`,`head_sha`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `review_runner` text DEFAULT 'fletcher' NOT NULL;
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_run_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`line` integer,
	`severity` text NOT NULL,
	`category` text,
	`confidence` real,
	`title` text,
	`message` text NOT NULL,
	`github_comment_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`review_run_id`) REFERENCES `review_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "findings_severity_check" CHECK("findings"."severity" in ('critical', 'warning', 'suggestion'))
);
--> statement-breakpoint
CREATE INDEX `findings_review_run_id_idx` ON `findings` (`review_run_id`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_installation_id` integer NOT NULL,
	`github_account_id` integer NOT NULL,
	`github_account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_github_installation_id_unique` ON `github_installations` (`github_installation_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` integer NOT NULL,
	`github_repository_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_github_repository_id_unique` ON `repositories` (`github_repository_id`);--> statement-breakpoint
CREATE INDEX `repositories_installation_id_idx` ON `repositories` (`installation_id`);--> statement-breakpoint
CREATE TABLE `review_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`pull_request_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`model` text,
	`started_at` integer,
	`completed_at` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_runs_status_check" CHECK("review_runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "review_runs_trigger_check" CHECK("review_runs"."trigger" in ('opened', 'synchronize', 'reopened', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_runs_repository_pr_head_unique` ON `review_runs` (`repository_id`,`pull_request_number`,`head_sha`);--> statement-breakpoint
CREATE INDEX `review_runs_repository_id_idx` ON `review_runs` (`repository_id`);
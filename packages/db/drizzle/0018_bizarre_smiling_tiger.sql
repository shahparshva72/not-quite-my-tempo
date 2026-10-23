CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`author_login` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`github_updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pull_requests_state_check" CHECK("pull_requests"."state" in ('open', 'closed', 'merged'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repository_number_unique` ON `pull_requests` (`repository_id`,`number`);--> statement-breakpoint
CREATE TABLE `user_active_days` (
	`user_id` integer NOT NULL,
	`day` text NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_active_days_day_idx` ON `user_active_days` (`day`);
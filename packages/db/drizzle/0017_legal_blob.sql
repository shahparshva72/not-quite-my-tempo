ALTER TABLE `workspaces` ADD `trial_reviews_carried` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `credits_carried_x100` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `credits_carried_period_start` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `data_deleted_at` integer;
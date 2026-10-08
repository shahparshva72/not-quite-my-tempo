ALTER TABLE `review_runs` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `review_runs` ADD `requested_model` text;--> statement-breakpoint
ALTER TABLE `review_runs` ADD `credits_x100` integer;--> statement-breakpoint
ALTER TABLE `review_runs` ADD `credits_workspace_id` integer REFERENCES workspaces(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `review_runs` ADD `credits_period_start` integer;--> statement-breakpoint
ALTER TABLE `review_runs` ADD `cost_usd_micros` integer;--> statement-breakpoint
CREATE INDEX `review_runs_credits_period_idx` ON `review_runs` (`credits_workspace_id`,`credits_period_start`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `plan_model` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `subscription_period_start` integer;--> statement-breakpoint
-- Every review before 0015 ran on a Google key (the platform's or the
-- workspace's), so record that for runs that reached the model.
UPDATE `review_runs` SET `provider` = 'gemini_api' WHERE `model` IS NOT NULL;

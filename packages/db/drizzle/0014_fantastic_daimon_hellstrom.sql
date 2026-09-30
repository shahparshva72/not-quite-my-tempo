ALTER TABLE `workspaces` ADD `polar_customer_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `polar_subscription_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `subscription_status` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `subscription_period_end` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `subscription_cancel_at_period_end` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `subscription_synced_at` integer;
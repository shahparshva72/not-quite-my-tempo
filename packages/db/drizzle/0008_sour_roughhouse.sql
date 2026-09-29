ALTER TABLE `review_runs` ADD `key_source` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `gemini_key_ciphertext` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `gemini_key_last4` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `gemini_key_updated_at` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `gemini_key_updated_by` integer REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `trial_reviews_used` integer DEFAULT 0 NOT NULL;
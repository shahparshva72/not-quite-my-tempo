ALTER TABLE `github_installations` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `removed_at` integer;
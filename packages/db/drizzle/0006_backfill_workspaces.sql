-- Backfill: one workspace per GitHub account that already has an
-- installation, named from that account's most recently updated
-- installation, then attach every installation to its workspace.
-- Idempotent: safe to re-run. Memberships are created at next sign-in.
INSERT INTO `workspaces` (`github_account_id`, `github_account_login`, `account_type`)
SELECT `gi`.`github_account_id`, `gi`.`github_account_login`, `gi`.`account_type`
FROM `github_installations` AS `gi`
WHERE `gi`.`id` = (
  SELECT `latest`.`id`
  FROM `github_installations` AS `latest`
  WHERE `latest`.`github_account_id` = `gi`.`github_account_id`
  ORDER BY `latest`.`updated_at` DESC, `latest`.`id` DESC
  LIMIT 1
)
ON CONFLICT (`github_account_id`) DO NOTHING;
--> statement-breakpoint
UPDATE `github_installations`
SET `workspace_id` = (
  SELECT `w`.`id`
  FROM `workspaces` AS `w`
  WHERE `w`.`github_account_id` = `github_installations`.`github_account_id`
)
WHERE `workspace_id` IS NULL;

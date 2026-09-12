import { env } from "cloudflare:workers";

export const resetAndSeedRepository = async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM findings"),
    env.DB.prepare("DELETE FROM review_runs"),
    env.DB.prepare("DELETE FROM repositories"),
    env.DB.prepare("DELETE FROM github_installations"),
    env.DB.prepare(
      `INSERT INTO github_installations
        (id, github_installation_id, github_account_id, github_account_login, account_type)
       VALUES (1, 1001, 2001, 'not-my-tempo', 'Organization')`,
    ),
    env.DB.prepare(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
       VALUES (1, 1, 3001, 'not-my-tempo', 'app', 'not-my-tempo/app', 'main')`,
    ),
  ]);
};

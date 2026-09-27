import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { databaseEffect } from "../errors.js";
import { githubInstallations } from "../schema/github-installations.js";
import { Database } from "../services/database.js";

export type GitHubInstallation = typeof githubInstallations.$inferSelect;

export type GitHubInstallationStatus = GitHubInstallation["status"];

export type UpsertGitHubInstallationInput = Pick<
  GitHubInstallation,
  | "githubInstallationId"
  | "githubAccountId"
  | "githubAccountLogin"
  | "accountType"
> & {
  // Omitted by pull request deliveries so a late event cannot revive a
  // suspended or removed installation; installation webhooks set it.
  readonly status?: GitHubInstallationStatus;
};

export class GitHubInstallationRepository extends Effect.Service<GitHubInstallationRepository>()(
  "@not-quite-my-tempo/db/GitHubInstallationRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        upsert: (input: UpsertGitHubInstallationInput) =>
          databaseEffect("github_installations.upsert", () =>
            client
              .insert(githubInstallations)
              .values(input)
              .onConflictDoUpdate({
                target: githubInstallations.githubInstallationId,
                set: {
                  githubAccountId: input.githubAccountId,
                  githubAccountLogin: input.githubAccountLogin,
                  accountType: input.accountType,
                  status: input.status ?? sql`${githubInstallations.status}`,
                  updatedAt: new Date(),
                },
              })
              .returning()
              .get(),
          ),
        listByGithubInstallationIds: (
          githubInstallationIds: readonly number[],
        ) =>
          githubInstallationIds.length === 0
            ? Effect.succeed<readonly GitHubInstallation[]>([])
            : databaseEffect(
                "github_installations.list_by_github_installation_ids",
                () =>
                  client
                    .select()
                    .from(githubInstallations)
                    .where(
                      sql`${githubInstallations.githubInstallationId} in (select value from json_each(${JSON.stringify(githubInstallationIds)}))`,
                    )
                    .all(),
              ),
      };
    }),
  },
) {}

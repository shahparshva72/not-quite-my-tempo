import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { databaseEffect, DatabaseError } from "../errors.js";
import { githubInstallations } from "../schema/github-installations.js";
import { workspaces } from "../schema/workspaces.js";
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
        /**
         * Upserts the installation and the workspace for its GitHub account
         * in one batch, so every installation belongs to a workspace and
         * reinstalls re-attach to the existing one.
         */
        upsert: (input: UpsertGitHubInstallationInput) => {
          const workspaceId = sql`(select ${workspaces.id} from ${workspaces} where ${workspaces.githubAccountId} = ${input.githubAccountId})`;

          return databaseEffect("github_installations.upsert", () =>
            client.batch([
              client
                .insert(workspaces)
                .values({
                  githubAccountId: input.githubAccountId,
                  githubAccountLogin: input.githubAccountLogin,
                  accountType: input.accountType,
                })
                .onConflictDoUpdate({
                  target: workspaces.githubAccountId,
                  set: {
                    githubAccountLogin: input.githubAccountLogin,
                    accountType: input.accountType,
                    updatedAt: new Date(),
                  },
                }),
              client
                .insert(githubInstallations)
                .values({ ...input, workspaceId })
                .onConflictDoUpdate({
                  target: githubInstallations.githubInstallationId,
                  set: {
                    githubAccountId: input.githubAccountId,
                    githubAccountLogin: input.githubAccountLogin,
                    accountType: input.accountType,
                    workspaceId,
                    status: input.status ?? sql`${githubInstallations.status}`,
                    updatedAt: new Date(),
                  },
                })
                .returning(),
            ]),
          ).pipe(
            Effect.flatMap(([, rows]) => {
              const installation = rows[0];

              return installation === undefined
                ? new DatabaseError({
                    operation: "github_installations.upsert",
                    cause: "upsert returned no row",
                  })
                : Effect.succeed(installation);
            }),
          );
        },
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

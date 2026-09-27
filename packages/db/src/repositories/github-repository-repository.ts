import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { repositories } from "../schema/repositories.js";
import { Database } from "../services/database.js";

export type GitHubRepository = typeof repositories.$inferSelect;

export type UpsertGitHubRepositoryInput = Pick<
  GitHubRepository,
  "installationId" | "githubRepositoryId" | "owner" | "name" | "defaultBranch"
>;

export type InstallationRepositoryInput = Omit<
  UpsertGitHubRepositoryInput,
  "installationId"
>;

export class GitHubRepositoryRepository extends Effect.Service<GitHubRepositoryRepository>()(
  "@not-quite-my-tempo/db/GitHubRepositoryRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      const upsertStatement = (
        input: UpsertGitHubRepositoryInput,
        restore: boolean,
      ) =>
        client
          .insert(repositories)
          .values({
            ...input,
            fullName: `${input.owner}/${input.name}`,
          })
          .onConflictDoUpdate({
            target: repositories.githubRepositoryId,
            set: {
              installationId: input.installationId,
              owner: input.owner,
              name: input.name,
              fullName: `${input.owner}/${input.name}`,
              defaultBranch: input.defaultBranch,
              removedAt: restore ? null : sql`${repositories.removedAt}`,
              updatedAt: new Date(),
            },
          })
          .returning();

      return {
        upsert: (input: UpsertGitHubRepositoryInput) =>
          databaseEffect("repositories.upsert", () =>
            upsertStatement(input, false).get(),
          ),
        /**
         * Reconciles an installation's repositories with the full list GitHub
         * reports: listed repositories are upserted and restored, the rest
         * of the installation's repositories are marked removed.
         */
        syncForInstallation: (
          installationId: number,
          inputs: readonly InstallationRepositoryInput[],
        ) =>
          databaseEffect("repositories.sync_for_installation", () => {
            const now = new Date();

            return client.batch([
              client
                .update(repositories)
                .set({ removedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(repositories.installationId, installationId),
                    isNull(repositories.removedAt),
                    sql`${repositories.githubRepositoryId} not in (select value from json_each(${JSON.stringify(inputs.map((input) => input.githubRepositoryId))}))`,
                  ),
                ),
              ...inputs.map((input) =>
                upsertStatement({ ...input, installationId }, true),
              ),
            ]);
          }).pipe(Effect.asVoid),
        removeAllForInstallation: (installationId: number) =>
          databaseEffect("repositories.remove_all_for_installation", () => {
            const now = new Date();

            return client
              .update(repositories)
              .set({ removedAt: now, updatedAt: now })
              .where(
                and(
                  eq(repositories.installationId, installationId),
                  isNull(repositories.removedAt),
                ),
              )
              .run();
          }).pipe(Effect.asVoid),
        listByGithubRepositoryIds: (githubRepositoryIds: readonly number[]) =>
          githubRepositoryIds.length === 0
            ? Effect.succeed<readonly GitHubRepository[]>([])
            : databaseEffect("repositories.list_by_github_repository_ids", () =>
                client
                  .select()
                  .from(repositories)
                  .where(
                    and(
                      isNull(repositories.removedAt),
                      sql`${repositories.githubRepositoryId} in (select value from json_each(${JSON.stringify(githubRepositoryIds)}))`,
                    ),
                  )
                  .all(),
              ),
        findById: (id: number) =>
          databaseEffect("repositories.find_by_id", () =>
            client
              .select()
              .from(repositories)
              .where(eq(repositories.id, id))
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

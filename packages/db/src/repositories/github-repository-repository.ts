import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { repositories } from "../schema/repositories.js";
import { Database } from "../services/database.js";

export type GitHubRepository = typeof repositories.$inferSelect;

export type UpsertGitHubRepositoryInput = Pick<
  GitHubRepository,
  "installationId" | "githubRepositoryId" | "owner" | "name" | "defaultBranch"
>;

export class GitHubRepositoryRepository extends Effect.Service<GitHubRepositoryRepository>()(
  "@not-quite-my-tempo/db/GitHubRepositoryRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        upsert: (input: UpsertGitHubRepositoryInput) =>
          databaseEffect("repositories.upsert", () =>
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
                  updatedAt: new Date(),
                },
              })
              .returning()
              .get(),
          ),
        listByGithubRepositoryIds: (githubRepositoryIds: readonly number[]) =>
          githubRepositoryIds.length === 0
            ? Effect.succeed<readonly GitHubRepository[]>([])
            : databaseEffect("repositories.list_by_github_repository_ids", () =>
                client
                  .select()
                  .from(repositories)
                  .where(
                    sql`${repositories.githubRepositoryId} in (select value from json_each(${JSON.stringify(githubRepositoryIds)}))`,
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

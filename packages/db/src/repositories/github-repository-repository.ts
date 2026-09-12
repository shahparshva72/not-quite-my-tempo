import { Effect } from "effect";

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
      };
    }),
  },
) {}

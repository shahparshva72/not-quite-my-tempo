import { eq, inArray } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { githubInstallations } from "../schema/github-installations.js";
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
        listByGithubInstallationIds: (
          githubInstallationIds: readonly number[],
        ) =>
          githubInstallationIds.length === 0
            ? Effect.succeed<readonly GitHubRepository[]>([])
            : databaseEffect(
                "repositories.list_by_github_installation_ids",
                () =>
                  client
                    .select({ repository: repositories })
                    .from(repositories)
                    .innerJoin(
                      githubInstallations,
                      eq(repositories.installationId, githubInstallations.id),
                    )
                    .where(
                      inArray(
                        githubInstallations.githubInstallationId,
                        // SAFETY: drizzle's inArray requires a mutable array
                        // type; the values are only read.
                        githubInstallationIds as number[],
                      ),
                    )
                    .all(),
              ).pipe(Effect.map((rows) => rows.map((row) => row.repository))),
        findByIdWithGithubInstallationId: (id: number) =>
          databaseEffect(
            "repositories.find_by_id_with_github_installation_id",
            () =>
              client
                .select({
                  repository: repositories,
                  githubInstallationId:
                    githubInstallations.githubInstallationId,
                })
                .from(repositories)
                .innerJoin(
                  githubInstallations,
                  eq(repositories.installationId, githubInstallations.id),
                )
                .where(eq(repositories.id, id))
                .get(),
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

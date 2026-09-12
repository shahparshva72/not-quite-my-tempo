import { Effect } from "effect";

import { databaseEffect } from "../errors.js";
import { githubInstallations } from "../schema/github-installations.js";
import { Database } from "../services/database.js";

export type GitHubInstallation = typeof githubInstallations.$inferSelect;

export type UpsertGitHubInstallationInput = Pick<
  GitHubInstallation,
  | "githubInstallationId"
  | "githubAccountId"
  | "githubAccountLogin"
  | "accountType"
>;

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

import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { users } from "../schema/users.js";
import { Database } from "../services/database.js";

export type User = typeof users.$inferSelect;

export interface UpsertUserInput {
  readonly githubUserId: number;
  readonly login: string;
}

export class UserRepository extends Effect.Service<UserRepository>()(
  "@not-quite-my-tempo/db/UserRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        upsert: (input: UpsertUserInput) =>
          databaseEffect("users.upsert", () =>
            client
              .insert(users)
              .values(input)
              .onConflictDoUpdate({
                target: users.githubUserId,
                set: {
                  login: input.login,
                  updatedAt: new Date(),
                },
              })
              .returning()
              .get(),
          ),
        /**
         * Deletes the account. Its sessions and memberships go with it, and
         * audit rows and Gemini keys it touched keep no link to it (the
         * foreign keys cascade or set null).
         */
        deleteById: (id: number) =>
          databaseEffect("users.delete_by_id", () =>
            client.delete(users).where(eq(users.id, id)).run(),
          ).pipe(Effect.asVoid),
        findByGithubUserId: (githubUserId: number) =>
          databaseEffect("users.find_by_github_user_id", () =>
            client
              .select()
              .from(users)
              .where(eq(users.githubUserId, githubUserId))
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

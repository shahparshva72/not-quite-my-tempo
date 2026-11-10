import { eq, lt } from "drizzle-orm";
import { Effect, Option, Context, Layer } from "effect";

import { databaseEffect } from "../errors.js";
import { userActiveDays } from "../schema/user-active-days.js";
import { users } from "../schema/users.js";
import { Database } from "../services/database.js";

export type User = typeof users.$inferSelect;

export interface UpsertUserInput {
  readonly githubUserId: number;
  readonly login: string;
}

const make = Effect.gen(function* () {
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
      ).pipe(Effect.map(Option.fromNullishOr)),
    /** Notes that the user opened a signed-in page on this UTC day. */
    recordActiveDay: (userId: number, day: string) =>
      databaseEffect("user_active_days.record", () =>
        client
          .insert(userActiveDays)
          .values({ userId, day })
          .onConflictDoNothing()
          .run(),
      ).pipe(Effect.asVoid),
    /** Forgets active days before this UTC day. */
    pruneActiveDaysBefore: (day: string) =>
      databaseEffect("user_active_days.prune", () =>
        client.delete(userActiveDays).where(lt(userActiveDays.day, day)).run(),
      ).pipe(Effect.asVoid),
  };
});

export class UserRepository extends Context.Service<
  UserRepository,
  Effect.Success<typeof make>
>()("@not-quite-my-tempo/db/UserRepository") {
  static readonly layer = Layer.effect(UserRepository, make);
}

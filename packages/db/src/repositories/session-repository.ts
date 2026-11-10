import { eq } from "drizzle-orm";
import { Effect, Option, Schema, Context, Layer } from "effect";

import { databaseEffect } from "../errors.js";
import { sessions } from "../schema/sessions.js";
import { users } from "../schema/users.js";
import { Database } from "../services/database.js";

type SessionRow = typeof sessions.$inferSelect;

export interface Session {
  readonly tokenHash: string;
  readonly userId: number;
  readonly repositoryIds: readonly number[];
  readonly githubTokenCiphertext: string | null;
  readonly accessVerifiedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface SessionWithUser extends Session {
  readonly githubUserId: number;
  readonly login: string;
}

export interface CreateSessionInput {
  readonly tokenHash: string;
  readonly userId: number;
  readonly repositoryIds: readonly number[];
  readonly githubTokenCiphertext: string | null;
  readonly accessVerifiedAt: Date;
  readonly expiresAt: Date;
}

const RepositoryIds = Schema.Array(
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

const parseRepositoryIds = (value: string): readonly number[] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(RepositoryIds))(value);

const toSession = (row: SessionRow): Session => ({
  tokenHash: row.tokenHash,
  userId: row.userId,
  repositoryIds: parseRepositoryIds(row.repositoryIds),
  githubTokenCiphertext: row.githubTokenCiphertext,
  accessVerifiedAt: row.accessVerifiedAt,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});

const toSessionWithUser = (
  row: SessionRow,
  githubUserId: number,
  login: string,
): SessionWithUser => ({
  ...toSession(row),
  githubUserId,
  login,
});

const make = Effect.gen(function* () {
  const { client } = yield* Database;

  return {
    create: (input: CreateSessionInput) =>
      databaseEffect("sessions.create", async () => {
        const row = await client
          .insert(sessions)
          .values({
            tokenHash: input.tokenHash,
            userId: input.userId,
            repositoryIds: JSON.stringify(input.repositoryIds),
            githubTokenCiphertext: input.githubTokenCiphertext,
            accessVerifiedAt: input.accessVerifiedAt,
            expiresAt: input.expiresAt,
          })
          .returning()
          .get();

        return toSession(row);
      }),
    findByTokenHash: (tokenHash: string) =>
      databaseEffect("sessions.find_by_token_hash", async () => {
        const row = await client
          .select({ session: sessions, user: users })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(eq(sessions.tokenHash, tokenHash))
          .get();

        return row === undefined
          ? undefined
          : toSessionWithUser(
              row.session,
              row.user.githubUserId,
              row.user.login,
            );
      }).pipe(Effect.map(Option.fromNullishOr)),
    /** Stores a freshly verified repository list on the session. */
    updateAccess: (
      tokenHash: string,
      repositoryIds: readonly number[],
      verifiedAt: Date,
    ) =>
      databaseEffect("sessions.update_access", async () => {
        await client
          .update(sessions)
          .set({
            repositoryIds: JSON.stringify(repositoryIds),
            accessVerifiedAt: verifiedAt,
          })
          .where(eq(sessions.tokenHash, tokenHash));
      }),
    revoke: (tokenHash: string) =>
      databaseEffect("sessions.revoke", async () => {
        await client.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      }),
    revokeAllForUser: (userId: number) =>
      databaseEffect("sessions.revoke_all_for_user", async () => {
        await client.delete(sessions).where(eq(sessions.userId, userId));
      }),
  };
});

export class SessionRepository extends Context.Service<
  SessionRepository,
  Effect.Success<typeof make>
>()("@not-quite-my-tempo/db/SessionRepository") {
  static readonly layer = Layer.effect(SessionRepository, make);
}

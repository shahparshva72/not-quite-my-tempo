import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  makeLiveLayer,
  SessionRepository,
  UserRepository,
} from "@not-quite-my-tempo/db";

import { resetAndSeedRepository } from "./database";

const run = <A, E>(
  effect: Effect.Effect<A, E, UserRepository | SessionRepository>,
) => Effect.runPromise(effect.pipe(Effect.provide(makeLiveLayer(env.DB))));

describe("account repositories", () => {
  beforeEach(resetAndSeedRepository);

  it("updates a GitHub login without changing the user identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserRepository;

        const first = yield* users.upsert({
          githubUserId: 9001,
          login: "old-login",
        });

        const updated = yield* users.upsert({
          githubUserId: 9001,
          login: "new-login",
        });

        return { first, updated };
      }),
    );

    expect(result.updated).toMatchObject({
      id: result.first.id,
      githubUserId: 9001,
      login: "new-login",
    });
  });

  it("keeps independent GitHub users separate", async () => {
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserRepository;

        const first = yield* users.upsert({
          githubUserId: 9001,
          login: "first-user",
        });

        const second = yield* users.upsert({
          githubUserId: 9002,
          login: "second-user",
        });

        return { first, second };
      }),
    );

    expect(result.first.id).not.toBe(result.second.id);
    expect(result.first.githubUserId).toBe(9001);
    expect(result.second.githubUserId).toBe(9002);
  });

  it("finds a session by its hash and revokes it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserRepository;
        const sessions = yield* SessionRepository;

        const user = yield* users.upsert({
          githubUserId: 9001,
          login: "session-user",
        });

        const expiresAt = new Date("2026-09-19T00:00:00.000Z");

        yield* sessions.create({
          tokenHash: "session-hash",
          userId: user.id,
          repositoryIds: [1, 2, 3],
          githubTokenCiphertext: null,
          accessVerifiedAt: new Date(0),
          expiresAt,
        });

        const found = yield* sessions.findByTokenHash("session-hash");
        yield* sessions.revoke("session-hash");
        const revoked = yield* sessions.findByTokenHash("session-hash");

        return { found, revoked };
      }),
    );

    expect(Option.getOrNull(result.found)).toMatchObject({
      userId: expect.any(Number),
      githubUserId: 9001,
      login: "session-user",
      repositoryIds: [1, 2, 3],
    });
    expect(Option.isNone(result.revoked)).toBe(true);
  });

  it("revokes every session for one user without affecting another user", async () => {
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserRepository;
        const sessions = yield* SessionRepository;

        const firstUser = yield* users.upsert({
          githubUserId: 9001,
          login: "first-user",
        });

        const secondUser = yield* users.upsert({
          githubUserId: 9002,
          login: "second-user",
        });

        const expiresAt = new Date("2026-09-19T00:00:00.000Z");

        yield* sessions.create({
          tokenHash: "first-session-one",
          userId: firstUser.id,
          repositoryIds: [1],
          githubTokenCiphertext: null,
          accessVerifiedAt: new Date(0),
          expiresAt,
        });
        yield* sessions.create({
          tokenHash: "first-session-two",
          userId: firstUser.id,
          repositoryIds: [1, 2],
          githubTokenCiphertext: null,
          accessVerifiedAt: new Date(0),
          expiresAt,
        });
        yield* sessions.create({
          tokenHash: "second-session",
          userId: secondUser.id,
          repositoryIds: [2],
          githubTokenCiphertext: null,
          accessVerifiedAt: new Date(0),
          expiresAt,
        });

        yield* sessions.revokeAllForUser(firstUser.id);

        return {
          firstSessionOne: yield* sessions.findByTokenHash("first-session-one"),
          firstSessionTwo: yield* sessions.findByTokenHash("first-session-two"),
          secondSession: yield* sessions.findByTokenHash("second-session"),
        };
      }),
    );

    expect(Option.isNone(result.firstSessionOne)).toBe(true);
    expect(Option.isNone(result.firstSessionTwo)).toBe(true);
    expect(Option.getOrNull(result.secondSession)).toMatchObject({
      githubUserId: 9002,
      login: "second-user",
    });
  });

  it("cascades sessions when a user is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const users = yield* UserRepository;
        const sessions = yield* SessionRepository;

        const user = yield* users.upsert({
          githubUserId: 9001,
          login: "deleted-user",
        });

        yield* sessions.create({
          tokenHash: "delete-cascade-hash",
          userId: user.id,
          repositoryIds: [1],
          githubTokenCiphertext: null,
          accessVerifiedAt: new Date(0),
          expiresAt: new Date("2026-09-19T00:00:00.000Z"),
        });

        const remaining = yield* Effect.tryPromise(async () => {
          await env.DB.prepare("DELETE FROM users WHERE id = ?")
            .bind(user.id)
            .run();

          return env.DB.prepare(
            "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
          )
            .bind(user.id)
            .first<{ count: number }>();
        });

        return remaining?.count ?? -1;
      }),
    );

    expect(result).toBe(0);
  });
});

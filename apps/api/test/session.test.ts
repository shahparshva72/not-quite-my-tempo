import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  makeLiveLayer,
  SessionRepository,
  UserRepository,
} from "@not-quite-my-tempo/db";

import {
  createSession,
  revokeSession,
  verifySession,
} from "../src/auth/session";
import { resetAndSeedRepository } from "./database";

const SECRET = "session-secret";

const runSession = <A, E>(effect: Effect.Effect<A, E, SessionRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeLiveLayer(env.DB))));

const createUser = () =>
  Effect.runPromise(
    UserRepository.upsert({ githubUserId: 4001, login: "neiman" }).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
    ),
  );

describe("server-side sessions", () => {
  beforeEach(resetAndSeedRepository);

  it("creates an opaque token and round-trips its database-backed payload", async () => {
    const user = await createUser();
    const token = await runSession(createSession(SECRET, user.id, [1, 2]));

    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = await env.DB.prepare("SELECT token_hash FROM sessions").all<{
      token_hash: string;
    }>();

    expect(stored.results.map((row) => row.token_hash)).not.toContain(token);

    const result = await runSession(verifySession(SECRET, token));
    expect(Option.getOrNull(result)).toMatchObject({
      userId: user.id,
      githubUserId: 4001,
      login: "neiman",
      repositoryIds: [1, 2],
    });

    const payload = Option.getOrNull(result);
    expect(payload?.expiresAt).toBeInstanceOf(Date);
    expect(payload?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects tampered, legacy, and differently keyed cookies", async () => {
    const user = await createUser();
    const token = await runSession(createSession(SECRET, user.id, [1]));
    const replacement = token.endsWith("0") ? "1" : "0";
    const tampered = `${token.slice(0, -1)}${replacement}`;

    expect(
      Option.isNone(await runSession(verifySession(SECRET, tampered))),
    ).toBe(true);
    expect(
      Option.isNone(
        await runSession(verifySession(SECRET, "eyJsb2dpbiI6Im5laW1hbiJ9.sig")),
      ),
    ).toBe(true);
    expect(
      Option.isNone(await runSession(verifySession("other-secret", token))),
    ).toBe(true);
  });

  it("rejects missing values and missing secrets", async () => {
    const user = await createUser();
    const token = await runSession(createSession(SECRET, user.id, [1]));

    expect(
      Option.isNone(await runSession(verifySession(SECRET, undefined))),
    ).toBe(true);
    expect(
      Option.isNone(await runSession(verifySession(undefined, token))),
    ).toBe(true);
    expect(Option.isNone(await runSession(verifySession("", token)))).toBe(
      true,
    );
    expect(
      Option.isNone(await runSession(verifySession(SECRET, "not-a-cookie"))),
    ).toBe(true);
  });

  it("rejects expired sessions", async () => {
    const user = await createUser();
    const token = await runSession(createSession(SECRET, user.id, [1]));

    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();

    expect(Option.isNone(await runSession(verifySession(SECRET, token)))).toBe(
      true,
    );
  });

  it("stops accepting a revoked session", async () => {
    const user = await createUser();
    const token = await runSession(createSession(SECRET, user.id, [1]));

    await runSession(revokeSession(SECRET, token));

    expect(Option.isNone(await runSession(verifySession(SECRET, token)))).toBe(
      true,
    );
  });
});

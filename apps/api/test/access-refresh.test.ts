import { env } from "cloudflare:workers";
import { Effect, Either, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import { refreshSessionAccess } from "../src/application/session-access";
import { GitHubOAuth, OAuthResponseError } from "../src/auth/github-oauth";
import type { UserAccess } from "../src/auth/github-oauth";
import { createSession, verifySession } from "../src/auth/session";
import {
  decryptToken,
  encryptToken,
  tokenContext,
} from "../src/auth/token-cipher";
import { GitHubAppAuth } from "../src/github/app-auth";
import { GitHubInstallationClient } from "../src/github/installation-client";
import { processGitHubWebhook } from "../src/github/webhook";
import { GitHubPullRequestClient } from "../src/github/pull-request-client";
import { ReviewWorkflow } from "../src/application/review-requests";
import {
  TEST_SESSION_SECRET,
  TEST_TOKEN_ENCRYPTION_KEY,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const key = TEST_TOKEN_ENCRYPTION_KEY;

describe("token encryption", () => {
  it("round-trips and binds each ciphertext to its user", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const sealed = yield* encryptToken(key, "gho_secret", "user:1");
        const opened = yield* decryptToken(key, sealed, "user:1");

        const otherUser = yield* Effect.either(
          decryptToken(key, sealed, "user:2"),
        );

        const otherKey = yield* Effect.either(
          decryptToken(btoa("\x01".repeat(32)), sealed, "user:1"),
        );

        const tampered = yield* Effect.either(
          decryptToken(key, `${sealed.slice(0, -4)}AAAA`, "user:1"),
        );

        const shortKey = yield* Effect.either(
          encryptToken(btoa("short"), "gho_secret", "user:1"),
        );

        return { sealed, opened, otherUser, otherKey, tampered, shortKey };
      }),
    );

    expect(results.sealed).toMatch(/^v1\./);
    expect(results.sealed).not.toContain("gho_secret");
    expect(results.opened).toBe("gho_secret");
    expect(Either.isLeft(results.otherUser)).toBe(true);
    expect(Either.isLeft(results.otherKey)).toBe(true);
    expect(Either.isLeft(results.tampered)).toBe(true);
    expect(results.shortKey).toMatchObject(
      Either.left({ reason: "invalid_key" }),
    );
  });
});

const account = (id: number) => ({
  installationId: id,
  accountId: id + 1000,
  accountLogin: `org-${id}`,
  accountType: "Organization",
});

const oauthLayer = (
  answer: Effect.Effect<UserAccess, OAuthResponseError>,
  calls: { count: number },
) =>
  Layer.succeed(
    GitHubOAuth,
    GitHubOAuth.of({
      exchangeCode: () => Effect.succeed("unused"),
      fetchUser: () => Effect.succeed({ githubUserId: 4001, login: "neiman" }),
      fetchUserAccess: () => {
        calls.count += 1;

        return answer;
      },
      isOrgOwner: () => Effect.succeed(false),
      revokeGrant: () => Effect.void,
    }),
  );

const appLayers = Layer.merge(
  Layer.succeed(
    GitHubAppAuth,
    GitHubAppAuth.of({
      mintInstallationToken: () =>
        Effect.succeed({ token: "ghs", expiresAt: new Date() }),
    }),
  ),
  Layer.succeed(
    GitHubInstallationClient,
    GitHubInstallationClient.of({ listRepositories: () => Effect.succeed([]) }),
  ),
);

const signedInSession = async (verifiedMinutesAgo: number) => {
  const user = await env.DB.prepare(
    "INSERT INTO users (github_user_id, login) VALUES (4001, 'neiman') RETURNING id",
  ).first<{ id: number }>();

  const userId = user?.id ?? 0;

  const payload = await Effect.runPromise(
    Effect.gen(function* () {
      const ciphertext = yield* encryptToken(
        key,
        "gho_user",
        tokenContext(userId),
      );

      const token = yield* createSession(
        TEST_SESSION_SECRET,
        userId,
        [3001],
        ciphertext,
      );

      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE sessions SET access_verified_at = ?")
          .bind(Date.now() - verifiedMinutesAgo * 60_000)
          .run(),
      );

      return yield* verifySession(TEST_SESSION_SECRET, token);
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

  return Option.getOrThrow(payload);
};

const refresh = (
  verifiedMinutesAgo: number,
  answer: Effect.Effect<UserAccess, OAuthResponseError>,
) =>
  signedInSession(verifiedMinutesAgo).then(async (session) => {
    const calls = { count: 0 };

    const result = await Effect.runPromise(
      refreshSessionAccess(session, key).pipe(
        Effect.provide(oauthLayer(answer, calls)),
        Effect.provide(appLayers),
        Effect.provide(makeLiveLayer(env.DB)),
      ),
    );

    return { result, calls };
  });

const storedSession = () =>
  env.DB.prepare("SELECT repository_ids FROM sessions").first<{
    repository_ids: string;
  }>();

describe("session access refresh", () => {
  beforeEach(resetAndSeedRepository);

  const newAccess = Effect.succeed<UserAccess>({
    installations: [account(1001)],
    repositoryIds: [3001, 3009],
  });

  it("trusts access verified within the last 10 minutes", async () => {
    const { result, calls } = await refresh(5, newAccess);

    expect(calls.count).toBe(0);
    expect(Option.getOrThrow(result).repositoryIds).toEqual([3001]);
  });

  it("re-reads stale access and stores it on the session and memberships", async () => {
    const { result, calls } = await refresh(11, newAccess);

    expect(calls.count).toBe(1);
    expect(Option.getOrThrow(result).repositoryIds).toEqual([3001, 3009]);
    expect((await storedSession())?.repository_ids).toBe("[3001,3009]");
    expect(
      await env.DB.prepare("SELECT workspace_id FROM memberships").first(),
    ).toEqual({ workspace_id: 1 });
  });

  it("ends the session when GitHub says the token was revoked", async () => {
    const { result } = await refresh(
      11,
      Effect.fail(new OAuthResponseError({ status: 401 })),
    );

    expect(Option.isNone(result)).toBe(true);
    expect(await storedSession()).toBeNull();
  });

  it("keeps the last verified access when GitHub is unavailable", async () => {
    const { result } = await refresh(
      11,
      Effect.fail(new OAuthResponseError({ status: 502 })),
    );

    expect(Option.getOrThrow(result).repositoryIds).toEqual([3001]);
    expect((await storedSession())?.repository_ids).toBe("[3001]");
  });
});

const secret = "test-webhook-secret";

type RevocationPayload =
  | { readonly action: string; readonly sender: { readonly id: number } }
  | {
      readonly action: string;
      readonly organization: { readonly id: number };
      readonly membership: { readonly user: { readonly id: number } };
    };

const signed = async (payload: RevocationPayload) => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new ArrayBuffer(body.byteLength);

  new Uint8Array(buffer).set(body);

  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmac, buffer),
  );

  return {
    buffer,
    header: `sha256=${Array.from(signature, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`,
  };
};

const deliver = async (githubEvent: string, payload: RevocationPayload) => {
  const { buffer, header } = await signed(payload);

  return Effect.runPromise(
    processGitHubWebhook(buffer, header, githubEvent, secret).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
      Effect.provide(appLayers),
      Effect.provide(
        Layer.succeed(
          GitHubPullRequestClient,
          GitHubPullRequestClient.of({
            fetchDiff: () => Effect.succeed(""),
            fetchDetails: () => Effect.die("unused"),
            createReview: () => Effect.die("unused"),
            listReviewComments: () => Effect.succeed([]),
            createIssueComment: () => Effect.void,
            createCommentReaction: () => Effect.void,
            fetchRepositoryFile: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
      Effect.provide(
        Layer.succeed(
          ReviewWorkflow,
          ReviewWorkflow.of({ start: () => Effect.succeed("unused") }),
        ),
      ),
    ),
  );
};

const count = (table: "sessions" | "memberships") =>
  env.DB.prepare(`SELECT count(*) AS total FROM ${table}`)
    .first<{ total: number }>()
    .then((row) => row?.total);

describe("revocation webhooks", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await signedInSession(0);
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, user_id, verified_at)
       SELECT 1, id, ? FROM users WHERE github_user_id = 4001`,
    )
      .bind(Date.now() - 60_000)
      .run();
  });

  it("drops every session and membership when the user revokes the app", async () => {
    const result = await deliver("github_app_authorization", {
      action: "revoked",
      sender: { id: 4001 },
    });

    expect(result).toEqual({ status: "revoked" });
    expect(await count("sessions")).toBe(0);
    expect(await count("memberships")).toBe(0);
  });

  it("removes the org membership and sessions when the org removes the user", async () => {
    const result = await deliver("organization", {
      action: "member_removed",
      organization: { id: 2001 },
      membership: { user: { id: 4001 } },
    });

    expect(result).toEqual({ status: "revoked" });
    expect(await count("memberships")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });

  it("does not undo a membership verified after the removal arrived", async () => {
    await env.DB.prepare("UPDATE memberships SET verified_at = ?")
      .bind(Date.now() + 60_000)
      .run();

    await deliver("organization", {
      action: "member_removed",
      organization: { id: 2001 },
      membership: { user: { id: 4001 } },
    });

    expect(await count("memberships")).toBe(1);
  });

  it("ignores users who never signed in and unrelated actions", async () => {
    expect(
      await deliver("github_app_authorization", {
        action: "revoked",
        sender: { id: 99_999 },
      }),
    ).toEqual({ status: "ignored" });
    expect(
      await deliver("organization", {
        action: "member_added",
        organization: { id: 2001 },
        membership: { user: { id: 4001 } },
      }),
    ).toEqual({ status: "ignored" });
    expect(await count("sessions")).toBe(1);
  });
});

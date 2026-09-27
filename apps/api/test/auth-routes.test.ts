import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import app from "../src/index";
import { GitHubOAuthLive } from "../src/auth/github-oauth";
import { createAuthRoutes } from "../src/auth/routes";
import {
  GitHubAppAuth,
  GitHubInstallationTokenError,
} from "../src/github/app-auth";
import { GitHubInstallationClient } from "../src/github/installation-client";
import { verifySession } from "../src/auth/session";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = {
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  GITHUB_OAUTH_CLIENT_ID: "client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
};

const identityFetch =
  (login: string): typeof fetch =>
  (input) => {
    const path = new URL(String(input)).pathname;

    switch (path) {
      case "/login/oauth/access_token":
        return Promise.resolve(Response.json({ access_token: "user-token" }));
      case "/user":
        return Promise.resolve(Response.json({ id: 4001, login }));
      case "/user/installations":
        return Promise.resolve(
          Response.json({
            installations: [
              {
                id: 1001,
                account: {
                  id: 2001,
                  login: "not-my-tempo",
                  type: "Organization",
                },
              },
            ],
          }),
        );
      case "/user/installations/1001/repositories":
        return Promise.resolve(Response.json({ repositories: [{ id: 3001 }] }));
      default:
        return Promise.resolve(
          new Response("Unexpected request", { status: 500 }),
        );
    }
  };

const authRoutes = (fetchImpl: typeof fetch) =>
  createAuthRoutes(
    GitHubOAuthLive({
      clientId: testEnv.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: testEnv.GITHUB_OAUTH_CLIENT_SECRET,
      fetchImpl,
    }),
  );

const responseCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith("nqmt_session="))
    ?.split(";")[0] ?? "";

describe("account sign-in and sign-out", () => {
  beforeEach(resetAndSeedRepository);

  it("persists the GitHub identity and redirects to an authenticated dashboard", async () => {
    const response = await authRoutes(identityFetch("neiman")).request(
      "https://example.com/callback?code=valid&state=expected",
      { headers: { cookie: "nqmt_oauth_state=expected" } },
      testEnv,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
    expect(response.headers.get("set-cookie")).toContain("nqmt_oauth_state=;");

    const cookie = responseCookie(response);
    expect(cookie).toMatch(/^nqmt_session=[a-f0-9]{64}$/);

    const dashboard = await app.request(
      "https://example.com/dashboard",
      { headers: { cookie } },
      testEnv,
    );

    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
    expect(await dashboard.text()).toContain("Signed in as neiman");

    const account = await env.DB.prepare(
      "SELECT github_user_id, login FROM users",
    ).first();

    expect(account).toMatchObject({ github_user_id: 4001, login: "neiman" });
  });

  it("keeps the account on rename and rotates the previous session", async () => {
    const oldCookie = await sessionCookie([3001]);
    const before = await env.DB.prepare("SELECT id FROM users").first();

    const response = await authRoutes(identityFetch("andrew")).request(
      "https://example.com/callback?code=valid&state=expected",
      { headers: { cookie: `nqmt_oauth_state=expected; ${oldCookie}` } },
      testEnv,
    );

    expect(response.status).toBe(302);
    const accounts = await env.DB.prepare("SELECT id, login FROM users").all();
    expect(accounts.results).toEqual([{ ...before, login: "andrew" }]);

    const oldSession = await Effect.runPromise(
      verifySession(
        TEST_SESSION_SECRET,
        oldCookie.slice("nqmt_session=".length),
      ).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(Option.isNone(oldSession)).toBe(true);
    expect(responseCookie(response)).not.toBe(oldCookie);
  });

  it("handles denied consent without creating an account or session", async () => {
    const response = await authRoutes(identityFetch("neiman")).request(
      "https://example.com/callback?error=access_denied&state=expected",
      { headers: { cookie: "nqmt_oauth_state=expected" } },
      testEnv,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "oauth_denied" },
    });
    expect(responseCookie(response)).toBe("");
    expect(await env.DB.prepare("SELECT id FROM users").first()).toBeNull();
  });

  it("shows browsers a sign-in page instead of a JSON error", async () => {
    const response = await authRoutes(identityFetch("neiman")).request(
      "https://example.com/callback?error=access_denied&state=expected",
      {
        headers: {
          cookie: "nqmt_oauth_state=expected",
          accept: "text/html,application/xhtml+xml",
        },
      },
      testEnv,
    );

    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("GitHub sign-in didn&#39;t finish");
    expect(body).toContain('href="/auth/login"');
  });

  it("rejects invalid state before making a GitHub request", async () => {
    let calls = 0;

    const fetchImpl: typeof fetch = () => {
      calls += 1;

      return Promise.resolve(new Response("Unexpected", { status: 500 }));
    };

    const response = await authRoutes(fetchImpl).request(
      "https://example.com/callback?code=valid&state=wrong",
      { headers: { cookie: "nqmt_oauth_state=expected" } },
      testEnv,
    );

    expect(response.status).toBe(401);
    expect(calls).toBe(0);
    expect(responseCookie(response)).toBe("");
  });

  it("does not grant a session when GitHub permission discovery fails", async () => {
    const goodFetch = identityFetch("neiman");

    const fetchImpl: typeof fetch = (input, init) =>
      new URL(String(input)).pathname.endsWith("/repositories")
        ? Promise.resolve(new Response("private-response", { status: 403 }))
        : goodFetch(input, init);

    const response = await authRoutes(fetchImpl).request(
      "https://example.com/callback?code=valid&state=expected",
      { headers: { cookie: "nqmt_oauth_state=expected" } },
      testEnv,
    );

    expect(response.status).toBe(500);
    expect(responseCookie(response)).toBe("");
    expect(await response.text()).not.toContain("private-response");
    expect(await env.DB.prepare("SELECT id FROM users").first()).toBeNull();
  });

  it("revokes a session on logout so the old cookie cannot be replayed", async () => {
    const cookie = await sessionCookie([3001]);

    const response = await app.request(
      "https://example.com/auth/logout",
      { method: "POST", headers: { cookie, origin: "https://example.com" } },
      testEnv,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    const replay = await app.request(
      "https://example.com/api/repositories",
      { headers: { cookie } },
      testEnv,
    );

    expect(replay.status).toBe(401);
  });

  it("rejects cross-origin and GET logout without revoking the session", async () => {
    const cookie = await sessionCookie([3001]);

    for (const origin of ["https://attacker.example", "null", ""]) {
      const response = await app.request(
        "https://example.com/auth/logout",
        { method: "POST", headers: { cookie, origin } },
        testEnv,
      );

      expect(response.status).toBe(403);
    }

    const get = await app.request(
      "https://example.com/auth/logout",
      { headers: { cookie } },
      testEnv,
    );

    expect(get.status).toBe(405);

    const stillActive = await app.request(
      "https://example.com/api/repositories",
      { headers: { cookie } },
      testEnv,
    );

    expect(stillActive.status).toBe(200);
  });
});

describe("sign-in installation sync", () => {
  beforeEach(resetAndSeedRepository);

  const account = (id: number) => ({
    id,
    account: { id: id + 1000, login: `org-${id}`, type: "Organization" },
  });

  // The user sees stored installation 1001 and new installation 5005.
  const accessFetch =
    (repositoryIds: readonly number[]): typeof fetch =>
    (input) => {
      const path = new URL(String(input)).pathname;

      switch (path) {
        case "/login/oauth/access_token":
          return Promise.resolve(Response.json({ access_token: "user-token" }));
        case "/user":
          return Promise.resolve(Response.json({ id: 4001, login: "neiman" }));
        case "/user/installations":
          return Promise.resolve(
            Response.json({ installations: [account(1001), account(5005)] }),
          );
        case "/user/installations/1001/repositories":
          return Promise.resolve(
            Response.json({
              repositories: repositoryIds.map((id) => ({ id })),
            }),
          );
        case "/user/installations/5005/repositories":
          return Promise.resolve(Response.json({ repositories: [] }));
        default:
          return Promise.resolve(new Response("Unexpected", { status: 500 }));
      }
    };

  const signIn = async (
    cookie: string,
    options: { repositoryIds?: readonly number[]; failSync?: boolean } = {},
  ) => {
    const synced: number[] = [];

    const githubAppLayer = Layer.merge(
      Layer.succeed(
        GitHubAppAuth,
        GitHubAppAuth.of({
          mintInstallationToken: (installationId) => {
            synced.push(installationId);

            return options.failSync === true
              ? Effect.fail(
                  new GitHubInstallationTokenError({ status: 503, body: "" }),
                )
              : Effect.succeed({ token: "ghs_sync", expiresAt: new Date() });
          },
        }),
      ),
      Layer.succeed(
        GitHubInstallationClient,
        GitHubInstallationClient.of({
          listRepositories: () => Effect.succeed([]),
        }),
      ),
    );

    const routes = createAuthRoutes(
      GitHubOAuthLive({
        clientId: testEnv.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: testEnv.GITHUB_OAUTH_CLIENT_SECRET,
        fetchImpl: accessFetch(options.repositoryIds ?? [3001]),
      }),
      githubAppLayer,
    );

    const response = await routes.request(
      "https://example.com/callback?code=valid&state=expected",
      { headers: { cookie: `nqmt_oauth_state=expected; ${cookie}` } },
      testEnv,
    );

    return { response, synced };
  };

  it("syncs installations the user can see that are not stored yet", async () => {
    const { response, synced } = await signIn("");

    expect(response.headers.get("location")).toBe("/dashboard");
    expect(synced).toEqual([5005]);
  });

  it("re-syncs a just-installed installation and returns to onboarding", async () => {
    const { response, synced } = await signIn(
      "nqmt_pending_installation=1001; nqmt_oauth_next=onboarding",
    );

    expect(response.headers.get("location")).toBe("/onboarding");
    expect(synced).toEqual([1001, 5005]);
    expect(response.headers.get("set-cookie")).toContain(
      "nqmt_pending_installation=;",
    );
  });

  it("does not sync a pending installation the user cannot see", async () => {
    const { synced } = await signIn("nqmt_pending_installation=7777");

    expect(synced).toEqual([5005]);
  });

  it("sends users without repositories to onboarding", async () => {
    const { response } = await signIn("", { repositoryIds: [] });

    expect(response.headers.get("location")).toBe("/onboarding");
  });

  it("signs the user in even when an installation sync fails", async () => {
    const { response } = await signIn("", { failSync: true });

    expect(response.status).toBe(302);
    expect(responseCookie(response)).toMatch(/^nqmt_session=[a-f0-9]{64}$/);
  });
});

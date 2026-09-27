import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import app from "../src/index";
import { GitHubOAuthLive } from "../src/auth/github-oauth";
import { createAuthRoutes } from "../src/auth/routes";
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
          Response.json({ installations: [{ id: 1001 }] }),
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

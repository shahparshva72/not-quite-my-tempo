import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

import { resetAndSeedRepository } from "./database";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

describe("Worker", () => {
  it("serves the landing page to signed-out visitors", async () => {
    const response = await request("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/auth/login"');
  });

  it("sends security headers that forbid scripts and framing", async () => {
    const response = await request("/");
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://polar.sh");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
  });

  it("sends signed-in visitors from the root to the dashboard", async () => {
    await resetAndSeedRepository();
    const cookie = await sessionCookie([3001]);

    const response = await request("/", { headers: { cookie } });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  it("reports health", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects API requests without a session", async () => {
    const response = await request("/api/repositories");

    expect(response.status).toBe(401);
  });

  it("rejects API requests with a tampered session cookie", async () => {
    const response = await request("/api/repositories", {
      headers: { cookie: "nqmt_session=forged.payload" },
    });

    expect(response.status).toBe(401);
  });

  it("serves accessible repositories for a stored session", async () => {
    await resetAndSeedRepository();

    const response = await request("/api/repositories", {
      headers: { cookie: await sessionCookie([3001]) },
    });

    expect(response.status).toBe(200);

    const body = await response.json<{
      repositories: { fullName: string }[];
    }>();

    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0]).toMatchObject({
      fullName: "not-my-tempo/app",
    });
  });

  it("returns the current persistent account without exposing session credentials", async () => {
    await resetAndSeedRepository();
    const cookie = await sessionCookie([3001]);

    const response = await request("/api/me", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();

    expect(body).toEqual({
      user: { id: expect.any(Number), githubUserId: 4001, login: "neiman" },
      session: { expiresAt: expect.any(String) },
    });
    expect((await request("/api/me")).status).toBe(401);
  });

  it("hides inaccessible repositories", async () => {
    await resetAndSeedRepository();

    const runsResponse = await request("/api/repositories/1/runs", {
      headers: { cookie: await sessionCookie([9999]) },
    });

    expect(runsResponse.status).toBe(404);
  });

  it("redirects the login route to GitHub with a state cookie", async () => {
    const response = await request("/auth/login");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://github.com/login/oauth/authorize",
    );
    expect(response.headers.get("set-cookie")).toContain("nqmt_oauth_state=");
  });

  it("rejects an OAuth callback with a mismatched state", async () => {
    const response = await request("/auth/callback?code=abc&state=mismatch", {
      headers: { cookie: "nqmt_oauth_state=expected" },
    });

    expect(response.status).toBe(401);
  });
});

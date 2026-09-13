import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import app from "../src/index";

import { createSession } from "../src/auth/session";
import { resetAndSeedRepository } from "./database";

const TEST_SESSION_SECRET = "test-session-secret";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

describe("Worker", () => {
  it("reports service metadata", async () => {
    const response = await request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "not-quite-my-tempo-api",
      message: "Hono on Cloudflare Workers with D1 and Effect",
    });
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

  it("serves accessible repositories for a signed session", async () => {
    await resetAndSeedRepository();

    const sessionCookie = await Effect.runPromise(
      createSession(TEST_SESSION_SECRET, "neiman", [1001]),
    );

    const response = await request("/api/repositories", {
      headers: { cookie: `nqmt_session=${sessionCookie}` },
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

  it("hides repositories from other installations", async () => {
    await resetAndSeedRepository();

    const sessionCookie = await Effect.runPromise(
      createSession(TEST_SESSION_SECRET, "neiman", [9999]),
    );

    const runsResponse = await request("/api/repositories/1/runs", {
      headers: { cookie: `nqmt_session=${sessionCookie}` },
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

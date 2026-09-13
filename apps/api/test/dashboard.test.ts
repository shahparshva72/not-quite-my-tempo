import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import type { GeminiReviewResult } from "@not-quite-my-tempo/gemini";

import app from "../src/index";
import { createSession } from "../src/auth/session";
import { persistReviewFindings } from "../src/application/review-workflow";
import { resetAndSeedRepository } from "./database";

const TEST_SESSION_SECRET = "test-session-secret";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, cookie?: string) =>
  app.request(
    `https://example.com${path}`,
    cookie === undefined ? undefined : { headers: { cookie } },
    testEnv,
  );

const sessionCookie = async (installationIds: readonly number[]) => {
  const value = await Effect.runPromise(
    createSession(TEST_SESSION_SECRET, "neiman", installationIds),
  );

  return `nqmt_session=${value}`;
};

const reviewResult: GeminiReviewResult = {
  review: {
    verdict: "almost",
    summary: "Not quite my tempo.",
    findings: [
      {
        filePath: "src/tempo.ts",
        line: 14,
        severity: "warning",
        category: null,
        confidence: 0.8,
        title: "Off-by-one in beat subdivision",
        message: "Guard subdivision before multiplying.",
      },
    ],
  },
  model: "gemini-3.8-flash",
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
};

const seedRun = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviewRuns = yield* ReviewRunRepository;

      const run = yield* reviewRuns.create({
        repositoryId: 1,
        pullRequestNumber: 42,
        headSha: "dash123",
        trigger: "opened",
      });

      yield* persistReviewFindings(run.id, reviewResult);

      return run;
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

describe("dashboard", () => {
  beforeEach(resetAndSeedRepository);

  it("shows the sign-in landing page without a session", async () => {
    const response = await request("/dashboard");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Sign in with GitHub");
    expect(body).toContain("/auth/login");
  });

  it("lists repositories with usage for a signed-in user", async () => {
    await seedRun();

    const response = await request("/dashboard", await sessionCookie([1001]));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("not-my-tempo/app");
    expect(body).toContain("/dashboard/repositories/1");
    expect(body).toContain("1200");
  });

  it("shows a repository's runs", async () => {
    await seedRun();

    const response = await request(
      "/dashboard/repositories/1",
      await sessionCookie([1001]),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("#42");
    expect(body).toContain("queued");
    expect(body).toContain("gemini-3.8-flash");
  });

  it("shows a run's findings", async () => {
    const run = await seedRun();

    const response = await request(
      `/dashboard/runs/${run.id}`,
      await sessionCookie([1001]),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Off-by-one in beat subdivision");
    expect(body).toContain("src/tempo.ts:14");
    expect(body).toContain("warning");
  });

  it("hides other installations' repositories behind a 404 page", async () => {
    await seedRun();

    const response = await request(
      "/dashboard/repositories/1",
      await sessionCookie([9999]),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("Not my chart");
  });
});

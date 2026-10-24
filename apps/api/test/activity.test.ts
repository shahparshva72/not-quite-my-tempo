import { env } from "cloudflare:workers";
import { Effect, TestClock, TestContext } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import app from "../src/index";
import { pruneActiveDays } from "../src/application/activity";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const activeDays = () =>
  env.DB.prepare("SELECT day FROM user_active_days ORDER BY day")
    .all<{ day: string }>()
    .then((result) => result.results.map((row) => row.day));

describe("active days", () => {
  beforeEach(resetAndSeedRepository);

  it("counts a signed-in user once per day, however many pages they open", async () => {
    const cookie = await sessionCookie([3001], "member");

    for (const path of [
      "/dashboard",
      "/dashboard/repositories/1",
      "/account",
    ]) {
      const response = await app.request(
        `https://example.com${path}`,
        { headers: { cookie } },
        testEnv,
      );

      expect(response.status).toBe(200);
    }

    expect(await activeDays()).toEqual([new Date().toISOString().slice(0, 10)]);
  });

  it("records nothing for visitors who aren't signed in", async () => {
    await app.request("https://example.com/dashboard", undefined, testEnv);

    expect(await activeDays()).toEqual([]);
  });

  it("forgets days older than the retention window", async () => {
    await sessionCookie([3001], "member");

    await env.DB.batch(
      ["2025-09-01", "2025-09-20", "2026-10-20"].map((day) =>
        env.DB.prepare(
          "INSERT INTO user_active_days (user_id, day) SELECT id, ? FROM users",
        ).bind(day),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-20T12:00:00Z"));
        yield* pruneActiveDays;
      }).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(TestContext.TestContext),
      ),
    );

    // 400 days before 2026-10-20 is 2025-09-15.
    expect(await activeDays()).toEqual(["2025-09-20", "2026-10-20"]);
  });
});

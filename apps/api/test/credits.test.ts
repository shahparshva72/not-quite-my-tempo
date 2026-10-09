import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import {
  downgradeOrder,
  estimateInputTokens,
  findCatalogModel,
  isSupportedGeneration,
  MODEL_CATALOG,
  reviewCostUsdMicros,
  reviewCreditsX100,
} from "@not-quite-my-tempo/reviewer";

import {
  chooseReviewKey,
  downgradeNotice,
  planMonthlyCredits,
} from "../src/application/review-keys";
import type { PlanSettings } from "../src/application/review-keys";
import { reviewKeyContext } from "../src/application/workspace-settings";
import { encryptToken } from "../src/auth/token-cipher";
import { TEST_TOKEN_ENCRYPTION_KEY } from "./authentication";
import { resetAndSeedRepository } from "./database";

const db = () => makeLiveLayer(env.DB);

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_START = Date.now() - 10 * DAY_MS;

const plan = (allowance = 200): PlanSettings => ({
  allowanceX100: allowance * 100,
  vendors: new Set(["google", "openai", "anthropic"] as const),
  geminiProvider: "gemini_api",
});

// A small diff stays under the large-review threshold.
const SMALL_DIFF = 10_000;

const LARGE_DIFF = 200_000;

const setPaidPlan = (model: string | null = null) =>
  env.DB.prepare(
    `UPDATE workspaces SET polar_customer_id = 'cus_1', subscription_status = 'active',
       subscription_period_start = ?, subscription_period_end = ?, plan_model = ?
     WHERE id = 1`,
  )
    .bind(PERIOD_START, Date.now() + 20 * DAY_MS, model)
    .run();

let shaCounter = 0;

const createRun = async (pullRequestNumber = 42) => {
  shaCounter += 1;

  return Effect.runPromise(
    ReviewRunRepository.create({
      repositoryId: 1,
      pullRequestNumber,
      headSha: `credits-${shaCounter}`,
      trigger: "opened",
    }).pipe(Effect.provide(db())),
  );
};

const choose = (runId: number, diffBytes = SMALL_DIFF, allowance = 200) =>
  Effect.runPromise(
    chooseReviewKey(runId, diffBytes, plan(allowance)).pipe(
      Effect.provide(db()),
    ),
  );

const creditsUsed = () =>
  Effect.runPromise(
    ReviewRunRepository.creditsUsedX100(1, new Date(PERIOD_START)).pipe(
      Effect.provide(db()),
    ),
  ).then((used) => used / 100);

// Paid-plan runs already charged this period, in the given state.
const seedCharged = async (creditsX100: number, status = "completed") => {
  const run = await createRun(900 + shaCounter);

  await env.DB.prepare(
    `UPDATE review_runs SET key_source = 'subscription', credits_x100 = ?,
       credits_workspace_id = 1, credits_period_start = ?, status = ?
     WHERE id = ?`,
  )
    .bind(creditsX100, PERIOD_START, status, run.id)
    .run();
};

const storeOwnKey = async () => {
  const ciphertext = await Effect.runPromise(
    encryptToken(
      TEST_TOKEN_ENCRYPTION_KEY,
      "sk-ownkey1234567890abcdefgh",
      reviewKeyContext(1, "openai"),
    ),
  );

  await env.DB.prepare(
    "UPDATE workspaces SET gemini_key_ciphertext = ?, gemini_key_last4 = 'efgh', gemini_key_provider = 'openai' WHERE id = 1",
  )
    .bind(ciphertext)
    .run();
};

describe("the model catalog", () => {
  it("only lists GPT-5.6+, Claude 5.5+, and Gemini 3.5+", () => {
    for (const model of MODEL_CATALOG) {
      expect(isSupportedGeneration(model.vendor, model.id)).toBe(true);
    }

    expect(isSupportedGeneration("openai", "gpt-5.4-mini")).toBe(false);
    expect(isSupportedGeneration("openai", "gpt-6-luna")).toBe(true);
    expect(isSupportedGeneration("anthropic", "claude-haiku-4-5")).toBe(false);
    expect(isSupportedGeneration("anthropic", "claude-haiku-5-5")).toBe(true);
    expect(isSupportedGeneration("google", "gemini-3.1-pro-preview")).toBe(
      false,
    );
    expect(isSupportedGeneration("google", "gemini-3.5-flash-lite")).toBe(true);
  });

  it("prices reviews by tier and size", () => {
    const flash = findCatalogModel("gemini-3.8-flash");
    const sonnet = findCatalogModel("claude-sonnet-5-5");
    const opus = findCatalogModel("claude-opus-5-5");

    expect(flash && reviewCreditsX100(flash, 20_000)).toBe(100);
    expect(flash && reviewCreditsX100(flash, 90_000)).toBe(300);
    expect(sonnet && reviewCreditsX100(sonnet, 20_000)).toBe(300);
    expect(opus && reviewCreditsX100(opus, 20_000)).toBeNull();
    expect(estimateInputTokens(LARGE_DIFF)).toBeGreaterThan(40_000);
  });

  it("only downgrades within the same vendor, most expensive first", () => {
    const pro = findCatalogModel("gemini-3.5-flash");
    const gpt = findCatalogModel("gpt-6.1-sol");
    const sonnet = findCatalogModel("claude-sonnet-5-5");

    expect(pro && downgradeOrder(pro).map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
    ]);
    expect(gpt && downgradeOrder(gpt).map((model) => model.id)).toEqual([
      "gpt-5.6-luna",
      "gpt-6-luna",
    ]);
    expect(sonnet && downgradeOrder(sonnet)).toEqual([]);
  });

  it("costs a review from its tokens", () => {
    const flash = findCatalogModel("gemini-3.8-flash");

    // 20k in × $0.75/M + 4k out × $3.75/M = $0.03.
    expect(flash && reviewCostUsdMicros(flash, 20_000, 4_000)).toBe(30_000);
  });

  it("reads the allowance from the environment", () => {
    expect(planMonthlyCredits("300")).toBe(300);
    expect(planMonthlyCredits(undefined)).toBe(200);
    expect(planMonthlyCredits("lots")).toBe(200);
  });
});

describe("paid plan credits", () => {
  beforeEach(resetAndSeedRepository);

  it("charges the chosen model's credits on the platform key", async () => {
    await setPaidPlan("claude-sonnet-5-5");
    const run = await createRun();

    const choice = await choose(run.id);

    expect(choice).toMatchObject({
      source: "subscription",
      model: "claude-sonnet-5-5",
      requestedModel: null,
      creditsX100: 300,
    });
    expect(await creditsUsed()).toBe(3);
    expect(downgradeNotice(choice)).toBeNull();
  });

  it("uses the default model, and charges large reviews three times", async () => {
    await setPaidPlan();
    const run = await createRun();

    expect(await choose(run.id, LARGE_DIFF)).toMatchObject({
      model: "gemini-3.8-flash",
      creditsX100: 300,
    });
  });

  it("never charges twice when the key step is retried", async () => {
    await setPaidPlan();
    const run = await createRun();

    await choose(run.id);
    await choose(run.id);

    expect(await creditsUsed()).toBe(1);
  });

  it("switches to a smaller model from the same vendor when credits run low", async () => {
    await setPaidPlan("gemini-3.5-flash");
    await seedCharged(19_800);
    const run = await createRun();

    const choice = await choose(run.id);

    expect(choice).toMatchObject({
      source: "subscription",
      model: "gemini-3.8-flash",
      requestedModel: "gemini-3.5-flash",
      creditsX100: 100,
    });
    expect(downgradeNotice(choice)).toContain("Switched to a smaller model");
    expect(await creditsUsed()).toBe(199);
  });

  it("never switches vendors: Claude with too few credits is blocked", async () => {
    await setPaidPlan("claude-sonnet-5-5");
    await seedCharged(19_800);
    const run = await createRun();

    expect((await choose(run.id)).source).toBe("credits_exhausted");
    expect(await creditsUsed()).toBe(198);
  });

  it("falls back to the workspace's own key, spending no credits", async () => {
    await setPaidPlan("claude-sonnet-5-5");
    await storeOwnKey();
    await seedCharged(20_000);
    const run = await createRun();

    expect((await choose(run.id)).source).toBe("workspace");
    expect(await creditsUsed()).toBe(200);
  });

  it("spends credits before the workspace's own key", async () => {
    await setPaidPlan();
    await storeOwnKey();
    const run = await createRun();

    expect((await choose(run.id)).source).toBe("subscription");
  });

  it("refunds a failed review and lets a retry claim again", async () => {
    await setPaidPlan();
    const run = await createRun();

    await choose(run.id);
    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'review_error' WHERE id = ?",
    )
      .bind(run.id)
      .run();

    expect(await creditsUsed()).toBe(0);

    await Effect.runPromise(
      ReviewRunRepository.requeueFailed(run.id).pipe(Effect.provide(db())),
    );

    expect((await choose(run.id)).source).toBe("subscription");
    expect(await creditsUsed()).toBe(1);
  });

  it("lets only one of two concurrent runs take the last credit", async () => {
    await setPaidPlan("gemini-3.8-flash");
    await seedCharged(19_900);

    const [first, second] = await Promise.all([createRun(), createRun(43)]);

    const choices = await Promise.all([choose(first.id), choose(second.id)]);

    // The loser switches to the Lite model (0.5) and can't fit that either.
    expect(choices.map((choice) => choice.source).sort()).toEqual([
      "credits_exhausted",
      "subscription",
    ]);
    expect(await creditsUsed()).toBe(200);
  });
});

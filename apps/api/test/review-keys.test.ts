import { env } from "cloudflare:workers";
import { Effect, Either, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import { checkGeminiKey } from "@not-quite-my-tempo/reviewer";

import {
  chooseReviewKey,
  DEFAULT_TRIAL_DAILY_REVIEW_CAP,
  explainBlockedReview,
  GeminiKeyUnreadableError,
  resolveReviewKey,
  trialDailyReviewCap,
} from "../src/application/review-keys";
import type { BlockedReviewCode } from "../src/application/review-keys";
import { reviewKeyContext } from "../src/application/workspace-settings";
import { encryptToken } from "../src/auth/token-cipher";
import { GitHubPullRequestClient } from "../src/github/pull-request-client";
import type { ReviewRequest } from "../src/github/review-request";
import { TEST_TOKEN_ENCRYPTION_KEY } from "./authentication";
import { resetAndSeedRepository } from "./database";

const db = () => makeLiveLayer(env.DB);

const createRun = (headSha: string, pullRequestNumber = 42) =>
  Effect.runPromise(
    ReviewRunRepository.create({
      repositoryId: 1,
      pullRequestNumber,
      headSha,
      trigger: "opened",
    }).pipe(Effect.provide(db())),
  );

// Free trial reviews workspace 1 has used, as the product counts them.
const trialUsed = () =>
  Effect.runPromise(
    ReviewRunRepository.trialReviewsUsed([1]).pipe(Effect.provide(db())),
  ).then((usage) => usage[0]?.used);

// Runs that already claimed the platform key, in the given state.
const seedTrialRuns = async (count: number, status: string) => {
  for (let index = 0; index < count; index += 1) {
    const run = await createRun(`seed-${status}-${index}`, 100 + index);

    await env.DB.prepare(
      "UPDATE review_runs SET key_source = 'platform', trial_workspace_id = 1, status = ? WHERE id = ?",
    )
      .bind(status, run.id)
      .run();
  }
};

const keySourceOf = (runId: number) =>
  env.DB.prepare("SELECT key_source FROM review_runs WHERE id = ?")
    .bind(runId)
    .first<{ key_source: string | null }>()
    .then((row) => row?.key_source ?? null);

const storeWorkspaceKey = async (apiKey: string) => {
  const ciphertext = await Effect.runPromise(
    encryptToken(
      TEST_TOKEN_ENCRYPTION_KEY,
      apiKey,
      reviewKeyContext(1, "gemini_api"),
    ),
  );

  await env.DB.prepare(
    "UPDATE workspaces SET gemini_key_ciphertext = ?, gemini_key_last4 = ? WHERE id = 1",
  )
    .bind(ciphertext, apiKey.slice(-4))
    .run();
};

const plan = {
  allowanceX100: 20_000,
  vendors: new Set(["google"] as const),
  geminiProvider: "gemini_api",
} as const;

const choose = (runId: number, trialDailyCap?: number) =>
  Effect.runPromise(
    chooseReviewKey(runId, 1_000, plan, trialDailyCap).pipe(
      Effect.provide(db()),
    ),
  );

// What chooseReviewKey returns for a source that claims no plan credits.
const choiceOf = (source: string) => ({
  source,
  repositoryId: 1,
  workspaceId: 1,
  model: null,
  requestedModel: null,
  creditsX100: null,
});

// Trial runs other workspaces started `hoursAgo`, which count only against
// the platform-wide daily cap.
const seedOtherTrialRuns = async (count: number, hoursAgo = 1) => {
  const startedAt = Date.now() - hoursAgo * 60 * 60 * 1000;

  for (let index = 0; index < count; index += 1) {
    const run = await createRun(`other-${hoursAgo}-${index}`, 500 + index);

    await env.DB.prepare(
      "UPDATE review_runs SET key_source = 'platform', status = 'completed', started_at = ?, created_at = ? WHERE id = ?",
    )
      .bind(startedAt, startedAt, run.id)
      .run();
  }
};

describe("choosing a review's key", () => {
  beforeEach(resetAndSeedRepository);

  it("uses the workspace's own key without using a free review", async () => {
    await storeWorkspaceKey("AIzaWorkspaceKey1234567890");
    const run = await createRun("own-key");

    expect(await choose(run.id)).toEqual(choiceOf("workspace"));
    expect(await keySourceOf(run.id)).toBe("workspace");
    expect(await trialUsed()).toBe(0);
  });

  it("claims a free review when the workspace has no key", async () => {
    const run = await createRun("trial");

    expect((await choose(run.id)).source).toBe("platform");
    expect(await keySourceOf(run.id)).toBe("platform");
    expect(await trialUsed()).toBe(1);
  });

  it("blocks the review once 5 free reviews are used", async () => {
    await seedTrialRuns(5, "completed");
    const run = await createRun("spent");

    expect(await choose(run.id)).toEqual(choiceOf("none"));
    expect(await keySourceOf(run.id)).toBeNull();
    expect(await trialUsed()).toBe(5);
  });

  it("gives the last free review to exactly one of two concurrent runs", async () => {
    await seedTrialRuns(4, "completed");

    const [first, second] = await Promise.all([
      createRun("race-a"),
      createRun("race-b"),
    ]);

    const choices = await Promise.all([choose(first.id), choose(second.id)]);

    expect(choices.map((choice) => choice.source).sort()).toEqual([
      "none",
      "platform",
    ]);
    expect(await trialUsed()).toBe(5);
  });
});

describe("the platform-wide daily trial cap", () => {
  beforeEach(resetAndSeedRepository);

  it("pauses free reviews once the cap is reached, without using one", async () => {
    await seedOtherTrialRuns(3);
    const run = await createRun("capped");

    expect(await choose(run.id, 3)).toEqual(choiceOf("trial_paused"));
    expect(await keySourceOf(run.id)).toBeNull();
    expect(await trialUsed()).toBe(0);
  });

  it("still claims a free review below the cap", async () => {
    await seedOtherTrialRuns(2);
    const run = await createRun("under-cap");

    expect((await choose(run.id, 3)).source).toBe("platform");
  });

  it("only counts trial reviews from the last 24 hours", async () => {
    await seedOtherTrialRuns(3, 25);
    const run = await createRun("old-runs");

    expect((await choose(run.id, 3)).source).toBe("platform");
  });

  it("says the workspace is out of free reviews when it is, cap or not", async () => {
    await seedTrialRuns(5, "completed");
    const run = await createRun("spent-and-capped");

    expect((await choose(run.id, 0)).source).toBe("none");
  });

  it("never pauses reviews on the workspace's own key", async () => {
    await storeWorkspaceKey("AIzaWorkspaceKey1234567890");
    const run = await createRun("own-key-capped");

    expect((await choose(run.id, 0)).source).toBe("workspace");
  });

  it("reads the cap from the environment, falling back to the default", () => {
    expect(trialDailyReviewCap("25")).toBe(25);
    expect(trialDailyReviewCap("0")).toBe(0);
    expect(trialDailyReviewCap(undefined)).toBe(DEFAULT_TRIAL_DAILY_REVIEW_CAP);
    expect(trialDailyReviewCap("")).toBe(DEFAULT_TRIAL_DAILY_REVIEW_CAP);
    expect(trialDailyReviewCap("-1")).toBe(DEFAULT_TRIAL_DAILY_REVIEW_CAP);
    expect(trialDailyReviewCap("ten")).toBe(DEFAULT_TRIAL_DAILY_REVIEW_CAP);
    expect(trialDailyReviewCap("2.5")).toBe(DEFAULT_TRIAL_DAILY_REVIEW_CAP);
  });
});

describe("counting free reviews fairly", () => {
  beforeEach(resetAndSeedRepository);

  it("never claims twice when the key step is retried", async () => {
    const run = await createRun("retried-step");

    expect((await choose(run.id)).source).toBe("platform");
    expect((await choose(run.id)).source).toBe("platform");
    expect(await trialUsed()).toBe(1);
  });

  it("counts reviews in progress and completed, never failed or cancelled", async () => {
    await seedTrialRuns(1, "queued");
    await seedTrialRuns(1, "running");
    await seedTrialRuns(1, "completed");
    await seedTrialRuns(2, "failed");
    await seedTrialRuns(1, "cancelled");

    expect(await trialUsed()).toBe(3);
  });

  it("gives a free review back as soon as a run fails, for any reason", async () => {
    const run = await createRun("fails-later");

    await choose(run.id);
    expect(await trialUsed()).toBe(1);

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'post_review_error' WHERE id = ?",
    )
      .bind(run.id)
      .run();

    expect(await trialUsed()).toBe(0);
  });

  it("keeps free reviews with the workspace that used them when a repository moves", async () => {
    const run = await createRun("before-transfer");

    await choose(run.id);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (id, github_account_id, github_account_login, account_type)
         VALUES (2, 2002, 'new-owner', 'Organization')`,
      ),
      env.DB.prepare(
        `INSERT INTO github_installations
          (id, github_installation_id, github_account_id, github_account_login, account_type, workspace_id)
         VALUES (2, 1002, 2002, 'new-owner', 'Organization', 2)`,
      ),
      env.DB.prepare(
        "UPDATE repositories SET installation_id = 2 WHERE id = 1",
      ),
    ]);

    const usage = await Effect.runPromise(
      ReviewRunRepository.trialReviewsUsed([1, 2]).pipe(Effect.provide(db())),
    );

    expect(usage).toEqual([
      { workspaceId: 1, used: 1 },
      { workspaceId: 2, used: 0 },
    ]);
  });

  it("charges a pull request once across a failed attempt and its retry", async () => {
    const run = await createRun("retry-once");

    await choose(run.id);
    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'stuck' WHERE id = ?",
    )
      .bind(run.id)
      .run();

    await Effect.runPromise(
      ReviewRunRepository.requeueFailed(run.id).pipe(Effect.provide(db())),
    );

    expect((await choose(run.id)).source).toBe("platform");
    expect(await trialUsed()).toBe(1);
  });

  it("holds a retried run to the same 5-review limit", async () => {
    const run = await createRun("retry-over-limit");

    await choose(run.id);
    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'gemini_error' WHERE id = ?",
    )
      .bind(run.id)
      .run();
    await seedTrialRuns(5, "completed");

    await Effect.runPromise(
      ReviewRunRepository.requeueFailed(run.id).pipe(Effect.provide(db())),
    );

    expect((await choose(run.id)).source).toBe("none");
    expect(await trialUsed()).toBe(5);
  });
});

describe("resolving the key inside the review step", () => {
  beforeEach(resetAndSeedRepository);

  const platformKeys = {
    gemini: { apiKey: "platform-key", provider: "gemini_api" },
    openai: "sk-platform-openai",
    anthropic: null,
  } as const;

  const resolve = (
    source: "workspace" | "platform" | "subscription",
    encryptionKey = TEST_TOKEN_ENCRYPTION_KEY,
    model: string | null = null,
  ) =>
    Effect.runPromise(
      Effect.either(
        resolveReviewKey(
          { ...choiceOf(source), source, model },
          platformKeys,
          undefined,
          encryptionKey,
        ).pipe(Effect.provide(db())),
      ),
    );

  it("returns the platform Gemini key and model for trial reviews", async () => {
    expect(await resolve("platform")).toEqual(
      Either.right({
        apiKey: "platform-key",
        provider: "gemini_api",
        model: "gemini-3.8-flash",
      }),
    );
  });

  it("uses the platform key of the claimed model's provider on the paid plan", async () => {
    expect(
      await resolve("subscription", TEST_TOKEN_ENCRYPTION_KEY, "gpt-6.1-sol"),
    ).toEqual(
      Either.right({
        apiKey: "sk-platform-openai",
        provider: "openai",
        model: "gpt-6.1-sol",
      }),
    );

    const missing = await resolve(
      "subscription",
      TEST_TOKEN_ENCRYPTION_KEY,
      "claude-sonnet-5-5",
    );

    expect(Either.isLeft(missing)).toBe(true);
  });

  it("decrypts the workspace key, and only with the right encryption key", async () => {
    await storeWorkspaceKey("AIzaWorkspaceKey1234567890");

    expect(await resolve("workspace")).toEqual(
      Either.right({
        apiKey: "AIzaWorkspaceKey1234567890",
        provider: "gemini_api",
        model: "gemini-3.8-flash",
      }),
    );

    const wrongKey = await resolve("workspace", btoa("\x07".repeat(32)));

    expect(wrongKey).toEqual(Either.left(new GeminiKeyUnreadableError()));
  });
});

describe("explaining a blocked review", () => {
  beforeEach(resetAndSeedRepository);

  const request: ReviewRequest = {
    installationId: 1001,
    installationAccountId: 2001,
    installationAccountType: "Organization",
    githubRepositoryId: 3001,
    owner: "not-my-tempo",
    repo: "app",
    defaultBranch: "main",
    pullRequestNumber: 42,
    headSha: "blocked",
    trigger: "opened",
  };

  const explain = async (
    runId: number,
    comments: string[],
    billingEnabled = false,
    reason: BlockedReviewCode = "no_gemini_key",
  ) =>
    Effect.runPromise(
      explainBlockedReview("ghs_token", request, runId, 1, 1, reason, {
        billingEnabled,
        creditAllowance: 200,
        appOrigin: "https://notmytempo.dev",
      }).pipe(
        Effect.provide(db()),
        Effect.provide(
          Layer.succeed(
            GitHubPullRequestClient,
            GitHubPullRequestClient.of({
              fetchDiff: () => Effect.succeed(""),
              fetchDetails: () => Effect.die("unused"),
              createReview: () => Effect.die("unused"),
              listReviewComments: () => Effect.succeed([]),
              createIssueComment: (_token, _ref, body) =>
                Effect.sync(() => {
                  comments.push(body);
                }),
              fetchRepositoryFile: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    );

  it("comments once per pull request, linking to the settings page", async () => {
    const comments: string[] = [];
    const first = await createRun("blocked-1");

    await explain(first.id, comments);

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'no_gemini_key' WHERE id = ?",
    )
      .bind(first.id)
      .run();

    const second = await createRun("blocked-2");

    await explain(second.id, comments);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("used its 5 free reviews");
    expect(comments[0]).toContain(
      "https://notmytempo.dev/workspaces/1/settings",
    );
  });

  it("explains a paused trial separately from a spent one", async () => {
    const comments: string[] = [];
    const missing = await createRun("blocked-missing");

    await explain(missing.id, comments);

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = 'no_gemini_key' WHERE id = ?",
    )
      .bind(missing.id)
      .run();

    const paused = await createRun("blocked-paused");

    await explain(paused.id, comments, false, "trial_paused");

    expect(comments).toHaveLength(2);
    expect(comments[1]).toContain("Free trial reviews are paused for today");
    expect(comments[1]).toContain(
      "https://notmytempo.dev/workspaces/1/settings",
    );
  });

  it("only mentions subscribing where billing is set up", async () => {
    const withoutBilling: string[] = [];
    const withBilling: string[] = [];

    await explain((await createRun("blocked-free")).id, withoutBilling);
    await explain((await createRun("blocked-paid", 43)).id, withBilling, true);

    expect(withoutBilling[0]).not.toContain("subscribe");
    expect(withoutBilling[0]).toContain(
      "can add an OpenAI, Anthropic, or Gemini key at",
    );
    expect(withBilling[0]).toContain("Gemini key or subscribe at");
  });
});

describe("checking a Gemini key", () => {
  // Answers per API: the Gemini API model list, then Vertex's countTokens.
  const check = (gemini: number, vertex: number) =>
    Effect.runPromise(
      Effect.either(
        checkGeminiKey("AQ.check", {
          fetchImpl: (input) =>
            Promise.resolve(
              new Response("{}", {
                status: String(input).includes("aiplatform") ? vertex : gemini,
              }),
            ),
        }),
      ),
    );

  it("tells which Google API accepts the key", async () => {
    expect(await check(200, 500)).toEqual(
      Either.right(Option.some("gemini_api")),
    );
    expect(await check(403, 200)).toEqual(
      Either.right(Option.some("vertex_express")),
    );
    expect(await check(404, 200)).toEqual(
      Either.right(Option.some("vertex_express")),
    );
  });

  it("rejects a key both APIs refuse, and reports when it couldn't tell", async () => {
    expect(await check(400, 401)).toEqual(Either.right(Option.none()));
    expect(Either.isLeft(await check(503, 401))).toBe(true);
    expect(Either.isLeft(await check(403, 503))).toBe(true);
  });
});

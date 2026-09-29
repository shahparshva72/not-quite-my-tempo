import { env } from "cloudflare:workers";
import { Effect, Either, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import { checkGeminiKey } from "@not-quite-my-tempo/gemini";

import {
  chooseReviewKey,
  explainMissingKey,
  GeminiKeyUnreadableError,
  resolveGeminiKey,
} from "../src/application/review-keys";
import { geminiKeyContext } from "../src/application/workspace-settings";
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

const workspaceRow = () =>
  env.DB.prepare(
    "SELECT trial_reviews_used FROM workspaces WHERE id = 1",
  ).first<{ trial_reviews_used: number }>();

const keySourceOf = (runId: number) =>
  env.DB.prepare("SELECT key_source FROM review_runs WHERE id = ?")
    .bind(runId)
    .first<{ key_source: string | null }>()
    .then((row) => row?.key_source ?? null);

const storeWorkspaceKey = async (apiKey: string) => {
  const ciphertext = await Effect.runPromise(
    encryptToken(TEST_TOKEN_ENCRYPTION_KEY, apiKey, geminiKeyContext(1)),
  );

  await env.DB.prepare(
    "UPDATE workspaces SET gemini_key_ciphertext = ?, gemini_key_last4 = ? WHERE id = 1",
  )
    .bind(ciphertext, apiKey.slice(-4))
    .run();
};

const choose = (runId: number) =>
  Effect.runPromise(chooseReviewKey(runId).pipe(Effect.provide(db())));

describe("choosing a review's Gemini key", () => {
  beforeEach(resetAndSeedRepository);

  it("uses the workspace's own key without touching the trial", async () => {
    await storeWorkspaceKey("AIzaWorkspaceKey1234567890");
    const run = await createRun("own-key");

    expect(await choose(run.id)).toEqual({
      source: "workspace",
      repositoryId: 1,
      workspaceId: 1,
    });
    expect(await keySourceOf(run.id)).toBe("workspace");
    expect((await workspaceRow())?.trial_reviews_used).toBe(0);
  });

  it("takes a free trial review when the workspace has no key", async () => {
    const run = await createRun("trial");

    expect((await choose(run.id)).source).toBe("platform");
    expect(await keySourceOf(run.id)).toBe("platform");
    expect((await workspaceRow())?.trial_reviews_used).toBe(1);
  });

  it("blocks the review once the 5 free reviews are used", async () => {
    await env.DB.prepare(
      "UPDATE workspaces SET trial_reviews_used = 5 WHERE id = 1",
    ).run();
    const run = await createRun("spent");

    expect(await choose(run.id)).toEqual({
      source: "none",
      repositoryId: 1,
      workspaceId: 1,
    });
    expect(await keySourceOf(run.id)).toBeNull();
    expect((await workspaceRow())?.trial_reviews_used).toBe(5);
  });

  it("gives the last free review to exactly one of two concurrent runs", async () => {
    await env.DB.prepare(
      "UPDATE workspaces SET trial_reviews_used = 4 WHERE id = 1",
    ).run();

    const [first, second] = await Promise.all([
      createRun("race-a"),
      createRun("race-b"),
    ]);

    const choices = await Promise.all([choose(first.id), choose(second.id)]);

    expect(choices.map((choice) => choice.source).sort()).toEqual([
      "none",
      "platform",
    ]);
    expect((await workspaceRow())?.trial_reviews_used).toBe(5);
  });
});

describe("resolving the key inside the Gemini step", () => {
  beforeEach(resetAndSeedRepository);

  const resolve = (
    source: "workspace" | "platform",
    encryptionKey = TEST_TOKEN_ENCRYPTION_KEY,
  ) =>
    Effect.runPromise(
      Effect.either(
        resolveGeminiKey(1, source, "platform-key", encryptionKey).pipe(
          Effect.provide(db()),
        ),
      ),
    );

  it("returns the platform key for trial reviews", async () => {
    expect(await resolve("platform")).toEqual(Either.right("platform-key"));
  });

  it("decrypts the workspace key, and only with the right encryption key", async () => {
    await storeWorkspaceKey("AIzaWorkspaceKey1234567890");

    expect(await resolve("workspace")).toEqual(
      Either.right("AIzaWorkspaceKey1234567890"),
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

  const explain = async (runId: number, comments: string[]) =>
    Effect.runPromise(
      explainMissingKey(
        "ghs_token",
        request,
        runId,
        1,
        1,
        "https://notmytempo.dev",
      ).pipe(
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
});

describe("checking a Gemini key", () => {
  const check = (status: number) =>
    Effect.runPromise(
      Effect.either(
        checkGeminiKey("AIzaCheck", {
          fetchImpl: () => Promise.resolve(new Response("{}", { status })),
        }),
      ),
    );

  it("accepts, rejects, or reports Gemini unavailable", async () => {
    expect(await check(200)).toEqual(Either.right(true));
    expect(await check(400)).toEqual(Either.right(false));
    expect(await check(403)).toEqual(Either.right(false));
    expect(Either.isLeft(await check(503))).toBe(true);
  });
});

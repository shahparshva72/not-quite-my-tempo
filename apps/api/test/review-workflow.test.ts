import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FindingRepository,
  makeLiveLayer,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import {
  GeminiResponseError,
  GeminiTimeoutError,
} from "@not-quite-my-tempo/gemini";
import type { GeminiReviewResult } from "@not-quite-my-tempo/gemini";

import {
  isRetryableReviewError,
  markReviewCompleted,
  markReviewRunning,
  persistReviewFindings,
  postReviewToGitHub,
  reviewErrorCode,
} from "../src/application/review-workflow";
import {
  GitHubPullRequestClient,
  PullRequestDiffTooLargeError,
  PullRequestResponseError,
} from "../src/github/pull-request-client";
import type { CreateReviewInput } from "../src/github/pull-request-client";
import { resetAndSeedRepository } from "./database";
import pullRequestDiff from "./fixtures/pull-request.diff?raw";

const reviewResult: GeminiReviewResult = {
  review: {
    verdict: "almost",
    summary: "Not quite my tempo.",
    findings: [
      {
        filePath: "src/tempo.ts",
        line: 14,
        severity: "warning",
        category: "correctness",
        confidence: 0.8,
        title: "Off-by-one in beat subdivision",
        message: "Guard subdivision before multiplying.",
      },
      {
        filePath: "src/cymbal.ts",
        line: null,
        severity: "suggestion",
        category: null,
        confidence: 0.6,
        title: "File-level nit",
        message: "Name the constant for the cymbal throw distance.",
      },
    ],
  },
  model: "gemini-3.8-flash",
  usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
};

describe("review workflow program", () => {
  beforeEach(resetAndSeedRepository);

  it("moves a review run through running and completed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const reviewRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 42,
          headSha: "workflow123",
          trigger: "opened",
        });

        const running = yield* markReviewRunning(reviewRun.id);
        const completed = yield* markReviewCompleted(reviewRun.id);

        return { running, completed };
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(result.running).toMatchObject({ status: "running" });
    expect(result.completed).toMatchObject({ status: "completed" });
  });

  it("persists findings and records the model on the run", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const reviewRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 42,
          headSha: "persist123",
          trigger: "opened",
        });

        const persisted = yield* persistReviewFindings(
          reviewRun.id,
          reviewResult,
        );

        const findings = yield* FindingRepository.listByReviewRun(reviewRun.id);

        const updatedRun = yield* reviewRuns.findById(reviewRun.id);

        return { persisted, findings, updatedRun };
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(result.persisted).toEqual({ findingCount: 2 });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      filePath: "src/tempo.ts",
      line: 14,
      severity: "warning",
      confidence: 0.8,
      githubCommentId: null,
    });
    expect(result.findings[1]).toMatchObject({
      filePath: "src/cymbal.ts",
      line: null,
      category: null,
    });
    expect(Option.getOrNull(result.updatedRun)).toMatchObject({
      model: "gemini-3.8-flash",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
    });
  });

  it("persists an empty review without touching the findings table", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const reviewRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 43,
          headSha: "clean123",
          trigger: "opened",
        });

        return yield* persistReviewFindings(reviewRun.id, {
          ...reviewResult,
          review: { ...reviewResult.review, findings: [] },
        });
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(result).toEqual({ findingCount: 0 });
  });
});

describe("postReviewToGitHub", () => {
  beforeEach(resetAndSeedRepository);

  const anchoredCommentBody =
    "**Off-by-one in beat subdivision**\n\n" +
    "Guard subdivision before multiplying.\n\n" +
    "_severity: warning \u00b7 confidence 0.80_";

  const request = {
    installationId: 1001,
    installationAccountId: 2001,
    installationAccountType: "Organization",
    githubRepositoryId: 3001,
    owner: "not-my-tempo",
    repo: "app",
    defaultBranch: "main",
    pullRequestNumber: 42,
    headSha: "post123",
    trigger: "opened" as const,
  };

  it("posts anchored comments inline, folds the rest, and stores comment IDs", async () => {
    const createReviewCalls: CreateReviewInput[] = [];

    const stubClientLayer = Layer.succeed(
      GitHubPullRequestClient,
      GitHubPullRequestClient.of({
        fetchDiff: () => Effect.succeed(""),
        fetchDetails: () =>
          Effect.succeed({
            title: "",
            body: null,
            baseRef: "main",
            baseSha: "base",
            headSha: "post123",
          }),
        createReview: (_token, _ref, review) => {
          createReviewCalls.push(review);

          return Effect.succeed({ reviewId: 555 });
        },
        listReviewComments: () =>
          Effect.succeed([
            {
              id: 9001,
              path: "src/tempo.ts",
              line: 14,
              body: anchoredCommentBody,
            },
          ]),
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const reviewRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 42,
          headSha: "post123",
          trigger: "opened",
        });

        yield* persistReviewFindings(reviewRun.id, reviewResult);

        const posted = yield* postReviewToGitHub(
          "ghs_token",
          request,
          reviewRun.id,
          reviewResult.review,
          pullRequestDiff,
        );

        const findings = yield* FindingRepository.listByReviewRun(reviewRun.id);

        return { posted, findings };
      }).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(stubClientLayer),
      ),
    );

    expect(result.posted).toEqual({
      reviewId: 555,
      inlineCommentCount: 1,
      summaryFindingCount: 1,
    });

    const review = createReviewCalls[0];
    expect(review?.commitId).toBe("post123");
    expect(review?.body).toContain("\ud83e\udd41 Almost. Almost.");
    expect(review?.body).toContain("Not quite my tempo.");
    expect(review?.body).toContain("Off the chart");
    expect(review?.body).toContain("src/cymbal.ts");
    expect(review?.comments).toEqual([
      { path: "src/tempo.ts", line: 14, body: anchoredCommentBody },
    ]);

    const anchored = result.findings.find(
      (finding) => finding.filePath === "src/tempo.ts",
    );

    const unanchored = result.findings.find(
      (finding) => finding.filePath === "src/cymbal.ts",
    );

    expect(anchored?.githubCommentId).toBe(9001);
    expect(unanchored?.githubCommentId).toBeNull();
  });
});

describe("review error taxonomy", () => {
  it("maps pipeline errors to stable error codes", () => {
    expect(
      reviewErrorCode(
        new PullRequestDiffTooLargeError({
          sizeBytes: 400_000,
          maxDiffBytes: 300_000,
        }),
      ),
    ).toBe("diff_too_large");
    expect(
      reviewErrorCode(
        new PullRequestResponseError({ status: 404, body: "missing" }),
      ),
    ).toBe("diff_fetch_error");
    expect(
      reviewErrorCode(new GeminiResponseError({ status: 500, body: "boom" })),
    ).toBe("gemini_error");
  });

  it("classifies transient failures as retryable and final ones as not", () => {
    expect(
      isRetryableReviewError(
        new PullRequestResponseError({ status: 503, body: "flaky" }),
      ),
    ).toBe(true);
    expect(
      isRetryableReviewError(
        new PullRequestResponseError({ status: 404, body: "missing" }),
      ),
    ).toBe(false);
    expect(
      isRetryableReviewError(
        new PullRequestDiffTooLargeError({
          sizeBytes: 400_000,
          maxDiffBytes: 300_000,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryableReviewError(new GeminiTimeoutError({ timeoutMillis: 1 })),
    ).toBe(false);
  });
});

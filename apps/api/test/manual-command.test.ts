import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  DAILY_REVIEW_RUN_CAP,
  handleManualReviewCommand,
  ReviewWorkflow,
} from "../src/application/review-requests";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import { GitHubAppAuth } from "../src/github/app-auth";
import { decodeIssueCommentBody } from "../src/github/manual-command";
import type { ManualReviewCommand } from "../src/github/manual-command";
import {
  GitHubPullRequestClient,
  ReviewSubmitResponseError,
} from "../src/github/pull-request-client";
import type {
  PullRequestRef,
  ReviewSubmitError,
} from "../src/github/pull-request-client";
import { resetAndSeedRepository } from "./database";

const issueCommentPayload = (
  body: string,
  onPullRequest: boolean,
  authorAssociation = "COLLABORATOR",
) => {
  const issueBase = { number: 42 };

  const issue = onPullRequest
    ? { ...issueBase, pull_request: { url: "https://api.github.test/pr/42" } }
    : issueBase;

  return {
    action: "created",
    comment: { id: 5001, body, author_association: authorAssociation },
    issue,
    installation: { id: 1001 },
    repository: {
      id: 3001,
      name: "app",
      default_branch: "main",
      owner: { id: 2001, login: "not-my-tempo", type: "Organization" },
    },
  };
};

const encodePayload = (payload: ReturnType<typeof issueCommentPayload>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new ArrayBuffer(bytes.byteLength);

  new Uint8Array(buffer).set(bytes);

  return buffer;
};

describe("decodeIssueCommentBody", () => {
  it("decodes a /fletcher again comment on a pull request", async () => {
    const result = await Effect.runPromise(
      decodeIssueCommentBody(
        encodePayload(issueCommentPayload("  /Fletcher Again  ", true)),
      ),
    );

    expect(Option.getOrNull(result)).toEqual({
      installationId: 1001,
      installationAccountId: 2001,
      installationAccountType: "Organization",
      githubRepositoryId: 3001,
      owner: "not-my-tempo",
      repo: "app",
      defaultBranch: "main",
      pullRequestNumber: 42,
      commentId: 5001,
    });
  });

  it("ignores ordinary comments", async () => {
    const result = await Effect.runPromise(
      decodeIssueCommentBody(
        encodePayload(issueCommentPayload("nice drumming", true)),
      ),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it("ignores commands on issues that are not pull requests", async () => {
    const result = await Effect.runPromise(
      decodeIssueCommentBody(
        encodePayload(issueCommentPayload("/fletcher again", false)),
      ),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it("ignores commands from commenters without repository standing", async () => {
    const result = await Effect.runPromise(
      decodeIssueCommentBody(
        encodePayload(issueCommentPayload("/fletcher again", true, "NONE")),
      ),
    );

    expect(Option.isNone(result)).toBe(true);
  });
});

describe("handleManualReviewCommand", () => {
  beforeEach(resetAndSeedRepository);

  const command: ManualReviewCommand = {
    installationId: 1001,
    installationAccountId: 2001,
    installationAccountType: "Organization",
    githubRepositoryId: 3001,
    owner: "not-my-tempo",
    repo: "app",
    defaultBranch: "main",
    pullRequestNumber: 42,
    commentId: 5001,
  };

  interface Reaction {
    readonly token: string;
    readonly ref: PullRequestRef;
    readonly commentId: number;
    readonly content: string;
  }

  const runCommand = (
    reactionResult: Effect.Effect<void, ReviewSubmitError> = Effect.void,
  ) => {
    const startedParams: ReviewWorkflowParams[] = [];
    const reactions: Reaction[] = [];
    const comments: string[] = [];

    const stubAuthLayer = Layer.succeed(
      GitHubAppAuth,
      GitHubAppAuth.of({
        mintInstallationToken: () =>
          Effect.succeed({ token: "ghs_manual", expiresAt: new Date() }),
      }),
    );

    const stubClientLayer = Layer.succeed(
      GitHubPullRequestClient,
      GitHubPullRequestClient.of({
        fetchDiff: () => Effect.succeed(""),
        fetchDetails: () =>
          Effect.succeed({
            title: "Play Caravan at 240",
            body: null,
            baseRef: "main",
            baseSha: "base456",
            headSha: "manual789",
          }),
        createReview: () => Effect.succeed({ reviewId: 1 }),
        listReviewComments: () => Effect.succeed([]),
        createIssueComment: (_token, _ref, body) =>
          Effect.sync(() => {
            comments.push(body);
          }),
        createCommentReaction: (token, ref, commentId, content) =>
          Effect.sync(() => {
            reactions.push({ token, ref, commentId, content });
          }).pipe(Effect.zipRight(reactionResult)),
        fetchRepositoryFile: () => Effect.succeed(Option.none()),
      }),
    );

    const stubWorkflowLayer = Layer.succeed(
      ReviewWorkflow,
      ReviewWorkflow.of({
        start: (params) => {
          startedParams.push(params);

          return Effect.succeed("wf-manual");
        },
      }),
    );

    return Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* handleManualReviewCommand(command);

        const reviewRuns = yield* ReviewRunRepository;

        const run = yield* reviewRuns.findByPullRequestCommit(
          1,
          42,
          "manual789",
        );

        return {
          outcome,
          run: Option.getOrNull(run),
          startedParams,
          reactions,
          comments,
        };
      }).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(stubAuthLayer),
        Effect.provide(stubClientLayer),
        Effect.provide(stubWorkflowLayer),
      ),
    );
  };

  it("resolves the head SHA and queues a manual review run", async () => {
    const result = await runCommand();

    expect(result.outcome).toMatchObject({ status: "queued" });
    expect(result.run).toMatchObject({
      trigger: "manual",
      headSha: "manual789",
      status: "queued",
    });
    expect(result.startedParams[0]?.request).toMatchObject({
      trigger: "manual",
      headSha: "manual789",
    });
    // The comment ID is for the reaction only, not the persisted request.
    expect(result.startedParams[0]?.request).not.toHaveProperty("commentId");
  });

  it("reacts to the comment with eyes once the review is queued", async () => {
    const result = await runCommand();

    expect(result.reactions).toEqual([
      {
        token: "ghs_manual",
        ref: { owner: "not-my-tempo", repo: "app", pullRequestNumber: 42 },
        commentId: 5001,
        content: "eyes",
      },
    ]);
  });

  it("reacts with eyes while the commit's review is still in progress", async () => {
    await runCommand();

    const repeat = await runCommand();

    expect(repeat.outcome).toMatchObject({
      status: "already_processed",
      runStatus: "queued",
    });
    expect(repeat.reactions.map((reaction) => reaction.content)).toEqual([
      "eyes",
    ]);
    expect(repeat.startedParams).toEqual([]);
  });

  it("reacts with +1 when the commit already has a finished review", async () => {
    const first = await runCommand();

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'completed' WHERE id = ?",
    )
      .bind(first.run?.id)
      .run();

    const repeat = await runCommand();

    expect(repeat.outcome).toMatchObject({
      status: "already_processed",
      runStatus: "completed",
    });
    expect(repeat.reactions.map((reaction) => reaction.content)).toEqual([
      "+1",
    ]);
    expect(repeat.comments).toEqual([]);
  });

  it("replies instead of reacting when the daily cap is hit", async () => {
    for (let index = 0; index < DAILY_REVIEW_RUN_CAP; index += 1) {
      await Effect.runPromise(
        ReviewRunRepository.create({
          repositoryId: 1,
          pullRequestNumber: 7,
          headSha: `busy${index}`,
          trigger: "opened",
        }).pipe(Effect.provide(makeLiveLayer(env.DB))),
      );
    }

    const result = await runCommand();

    expect(result.outcome).toEqual({ status: "rate_limited" });
    expect(result.reactions).toEqual([]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toContain(`${DAILY_REVIEW_RUN_CAP} reviews`);
  });

  it("stays quiet when reviews are off for the repository", async () => {
    await env.DB.prepare("UPDATE repositories SET enabled = 0").run();

    const result = await runCommand();

    expect(result.outcome).toEqual({ status: "ignored" });
    expect(result.reactions).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  it("still queues the review when the reaction fails", async () => {
    const result = await runCommand(
      Effect.fail(
        new ReviewSubmitResponseError({ status: 403, body: "forbidden" }),
      ),
    );

    expect(result.outcome).toMatchObject({ status: "queued" });
    expect(result.reactions).toHaveLength(1);
  });
});

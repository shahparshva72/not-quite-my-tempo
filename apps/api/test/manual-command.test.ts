import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  handleManualReviewCommand,
  ReviewWorkflow,
} from "../src/application/review-requests";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import { GitHubAppAuth } from "../src/github/app-auth";
import { decodeIssueCommentBody } from "../src/github/manual-command";
import type { ManualReviewCommand } from "../src/github/manual-command";
import { GitHubPullRequestClient } from "../src/github/pull-request-client";
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
    comment: { body, author_association: authorAssociation },
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
  };

  it("resolves the head SHA and queues a manual review run", async () => {
    const startedParams: ReviewWorkflowParams[] = [];

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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* handleManualReviewCommand(command);

        const reviewRuns = yield* ReviewRunRepository;

        const run = yield* reviewRuns.findByPullRequestCommit(
          1,
          42,
          "manual789",
        );

        return { outcome, run: Option.getOrNull(run) };
      }).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(stubAuthLayer),
        Effect.provide(stubClientLayer),
        Effect.provide(stubWorkflowLayer),
      ),
    );

    expect(result.outcome).toMatchObject({ status: "queued" });
    expect(result.run).toMatchObject({
      trigger: "manual",
      headSha: "manual789",
      status: "queued",
    });
    expect(startedParams[0]?.request).toMatchObject({
      trigger: "manual",
      headSha: "manual789",
    });
  });
});

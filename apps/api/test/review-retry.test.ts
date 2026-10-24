import { env } from "cloudflare:workers";
import { Effect, Either, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import type { WorkspaceRole } from "@not-quite-my-tempo/db";

import app from "../src/index";
import { ForbiddenError } from "../src/application/authorization";
import { ReviewWorkflow } from "../src/application/review-requests";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import { retryFailedReview } from "../src/application/review-retry";
import { GitHubAppAuth } from "../src/github/app-auth";
import { GitHubPullRequestClient } from "../src/github/pull-request-client";
import {
  sessionCookie,
  testAccess,
  TEST_SESSION_SECRET,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const live = makeLiveLayer(env.DB);

const seedRun = (status: "failed" | "running" | "completed") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const run = yield* ReviewRunRepository.create({
        repositoryId: 1,
        pullRequestNumber: 42,
        headSha: "failed123",
        trigger: "opened",
      });

      if (status === "failed") {
        yield* ReviewRunRepository.markFailed(
          run.id,
          "review_error",
          "provider down",
        );
      } else if (status === "running") {
        yield* ReviewRunRepository.markRunning(run.id);
      } else {
        yield* ReviewRunRepository.markCompleted(run.id);
      }

      return run;
    }).pipe(Effect.provide(live)),
  );

const findRun = (id: number) =>
  Effect.runPromise(
    ReviewRunRepository.findById(id).pipe(
      Effect.map(Option.getOrNull),
      Effect.provide(live),
    ),
  );

const retry = async (
  reviewRunId: number,
  role: WorkspaceRole,
  headSha = "failed123",
) => {
  const started: ReviewWorkflowParams[] = [];
  const access = await testAccess([3001], role);

  const stubs = Layer.mergeAll(
    Layer.succeed(
      GitHubAppAuth,
      GitHubAppAuth.of({
        mintInstallationToken: () =>
          Effect.succeed({ token: "ghs_retry", expiresAt: new Date() }),
      }),
    ),
    Layer.succeed(
      GitHubPullRequestClient,
      GitHubPullRequestClient.of({
        fetchDiff: () => Effect.succeed(""),
        fetchDetails: () =>
          Effect.succeed({
            title: "Play Caravan at 240",
            body: null,
            baseRef: "main",
            baseSha: "base456",
            headSha,
          }),
        createReview: () => Effect.succeed({ reviewId: 1 }),
        listReviewComments: () => Effect.succeed([]),
        createIssueComment: () => Effect.void,
        createCommentReaction: () => Effect.void,
        fetchRepositoryFile: () => Effect.succeed(Option.none()),
        fetchTree: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      ReviewWorkflow,
      ReviewWorkflow.of({
        start: (params) =>
          Effect.sync(() => {
            started.push(params);

            return "wf-retry";
          }),
      }),
    ),
  );

  const outcome = await Effect.runPromise(
    retryFailedReview(access, reviewRunId).pipe(
      Effect.either,
      Effect.provide(live),
      Effect.provide(stubs),
    ),
  );

  return { outcome, started };
};

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = async (
  path: string,
  role: WorkspaceRole,
  method: "GET" | "POST" = "GET",
) => {
  const cookie = await sessionCookie([3001], role);

  return app.request(
    `https://example.com${path}`,
    { method, headers: { cookie, origin: "https://example.com" } },
    testEnv,
  );
};

describe("retrying a failed review", () => {
  beforeEach(resetAndSeedRepository);

  it("requeues the failed run when the pull request hasn't moved", async () => {
    const run = await seedRun("failed");

    const { outcome, started } = await retry(run.id, "admin");

    expect(outcome).toEqual(
      Either.right({ status: "queued", reviewRunId: run.id }),
    );
    expect(await findRun(run.id)).toMatchObject({
      status: "queued",
      attempt: 2,
    });
    expect(started[0]).toMatchObject({
      attempt: 2,
      request: { trigger: "manual", headSha: "failed123" },
    });
  });

  it("reviews the latest commit when the pull request has moved on", async () => {
    const run = await seedRun("failed");

    const { outcome, started } = await retry(run.id, "admin", "newer789");

    expect(Either.getOrThrow(outcome)).toMatchObject({ status: "queued" });
    expect(started[0]?.request).toMatchObject({ headSha: "newer789" });
    expect(await findRun(run.id)).toMatchObject({ status: "failed" });
  });

  it("leaves a run that isn't failed alone", async () => {
    const run = await seedRun("completed");

    const { outcome, started } = await retry(run.id, "admin");

    expect(outcome).toEqual(
      Either.right({ status: "not_failed", reviewRunId: run.id }),
    );
    expect(started).toEqual([]);
  });

  it("is for admins and owners only", async () => {
    const run = await seedRun("failed");

    const { outcome, started } = await retry(run.id, "member");

    const error = Option.getOrNull(Either.getLeft(outcome));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ requiredRole: "admin" });
    expect(started).toEqual([]);
    expect(await findRun(run.id)).toMatchObject({ status: "failed" });
  });

  it("offers admins a retry button on a failed review", async () => {
    const run = await seedRun("failed");

    const page = await (
      await request(`/dashboard/runs/${run.id}`, "admin")
    ).text();

    expect(page).toContain(`action="/dashboard/runs/${run.id}/retry"`);
  });

  it("tells members to comment instead", async () => {
    const run = await seedRun("failed");

    const page = await (
      await request(`/dashboard/runs/${run.id}`, "member")
    ).text();

    expect(page).not.toContain(`/dashboard/runs/${run.id}/retry`);
    expect(page).toContain("<code>/fletcher again</code>");
  });

  it("offers no retry once the pull request is merged", async () => {
    const run = await seedRun("failed");

    await env.DB.prepare(
      `INSERT INTO pull_requests
        (repository_id, number, title, author_login, head_ref, base_ref, state, github_updated_at)
       VALUES (1, 42, 'Play Caravan at 240', 'andrew', 'double-time', 'main', 'merged', 0)`,
    ).run();

    const page = await (
      await request(`/dashboard/runs/${run.id}`, "admin")
    ).text();

    expect(page).not.toContain(`/dashboard/runs/${run.id}/retry`);
    expect(page).not.toContain("/fletcher again");
  });

  it("forbids members from posting a retry", async () => {
    const run = await seedRun("failed");

    const response = await request(
      `/dashboard/runs/${run.id}/retry`,
      "member",
      "POST",
    );

    expect(response.status).toBe(403);
  });

  it("sends a retry of a finished review back to its page", async () => {
    const run = await seedRun("completed");

    const response = await request(
      `/dashboard/runs/${run.id}/retry`,
      "admin",
      "POST",
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/dashboard/runs/${run.id}`);
  });

  it("explains when GitHub can't be reached, and leaves the run failed", async () => {
    const run = await seedRun("failed");
    const cookie = await sessionCookie([3001], "admin");

    // An unusable App key fails before any request leaves the Worker.
    const response = await app.request(
      `https://example.com/dashboard/runs/${run.id}/retry`,
      { method: "POST", headers: { cookie, origin: "https://example.com" } },
      { ...testEnv, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not-a-key" },
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("GitHub didn&#39;t answer");
    expect(await findRun(run.id)).toMatchObject({ status: "failed" });
  });
});

describe("review page while Fletcher is reviewing", () => {
  beforeEach(resetAndSeedRepository);

  it("reloads itself until the review finishes", async () => {
    const running = await seedRun("running");

    const page = await (
      await request(`/dashboard/runs/${running.id}`, "member")
    ).text();

    expect(page).toMatch(/<meta\s+http-equiv="refresh"\s+content="15"/);
    expect(page).toContain("This page updates on its own.");
  });

  it("stops reloading once it has finished", async () => {
    const completed = await seedRun("completed");

    const page = await (
      await request(`/dashboard/runs/${completed.id}`, "member")
    ).text();

    expect(page).not.toContain('http-equiv="refresh"');
  });
});

import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  handleReviewRequest,
  ReviewWorkflowLive,
  workflowInstanceId,
} from "../src/application/review-requests";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import {
  recoverStuckRuns,
  ReviewWorkflowStatus,
  STUCK_AFTER_MILLIS,
} from "../src/application/stuck-runs";
import type { ReviewRequest } from "../src/github/review-request";
import { resetAndSeedRepository } from "./database";

const request = (
  trigger: ReviewRequest["trigger"],
  headSha = "abc123",
): ReviewRequest => ({
  installationId: 1001,
  installationAccountId: 2001,
  installationAccountType: "Organization",
  githubRepositoryId: 3001,
  owner: "not-my-tempo",
  repo: "app",
  defaultBranch: "main",
  pullRequestNumber: 42,
  headSha,
  trigger,
});

// A Workflow binding that records the instances it was asked to create.
const recordingWorkflow = (created: string[]) => {
  const instance = (id: string): WorkflowInstance => ({
    id,
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    delete: async () => undefined,
    status: async () => ({ status: "queued" }),
    sendEvent: async () => undefined,
  });

  const binding: Workflow<ReviewWorkflowParams> = {
    get: async (id) => instance(id),
    create: async (options) => {
      const id = options?.id ?? "generated";

      created.push(id);

      return instance(id);
    },
    createBatch: async () => [],
    deleteBatch: async () => ({ deleted: [], errors: [] }),
  };

  return binding;
};

const handle = (
  reviewRequest: ReviewRequest,
  created: string[],
  dailyRunCap?: number,
) =>
  Effect.runPromise(
    handleReviewRequest(reviewRequest, dailyRunCap).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
      Effect.provide(
        ReviewWorkflowLive(recordingWorkflow(created), "https://example.com"),
      ),
    ),
  );

// The run a delivery queued or matched; -1 when it was ignored or capped.
const runIdOf = (result: Awaited<ReturnType<typeof handle>>): number =>
  result.status === "queued" || result.status === "already_processed"
    ? result.reviewRunId
    : -1;

const runRow = (id: number) =>
  env.DB.prepare(
    "SELECT status, attempt, trigger, error_code, key_source FROM review_runs WHERE id = ?",
  )
    .bind(id)
    .first();

const failRun = (id: number, errorCode: string) =>
  env.DB.batch([
    env.DB.prepare(
      "UPDATE review_runs SET status = 'failed', error_code = ?, key_source = 'platform' WHERE id = ?",
    ).bind(errorCode, id),
    env.DB.prepare(
      `INSERT INTO findings (review_run_id, file_path, line, severity, message)
       VALUES (?, 'src/old.ts', 1, 'warning', 'From the failed attempt.')`,
    ).bind(id),
  ]);

const retryCount = () =>
  env.DB.prepare("SELECT count(*) AS total FROM review_run_retries")
    .first<{ total: number }>()
    .then((row) => row?.total);

const findingCount = (id: number) =>
  env.DB.prepare(
    "SELECT count(*) AS total FROM findings WHERE review_run_id = ?",
  )
    .bind(id)
    .first<{ total: number }>()
    .then((row) => row?.total);

describe("/fletcher again on the same commit", () => {
  beforeEach(resetAndSeedRepository);

  it("retries a failed review as a new attempt with a fresh workflow", async () => {
    const created: string[] = [];
    const first = runIdOf(await handle(request("opened"), created));

    await failRun(first, "no_gemini_key");

    const retry = await handle(request("manual"), created);

    expect(retry).toEqual({ status: "queued", reviewRunId: first });
    expect(await runRow(first)).toEqual({
      status: "queued",
      attempt: 2,
      trigger: "manual",
      error_code: null,
      key_source: null,
    });
    expect(await findingCount(first)).toBe(0);
    expect(created).toEqual([
      `review-run-${first}`,
      `review-run-${first}-attempt-2`,
    ]);
  });

  it("still treats completed reviews and non-manual repeats as duplicates", async () => {
    const created: string[] = [];
    const completed = runIdOf(await handle(request("opened", "done"), created));

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'completed' WHERE id = ?",
    )
      .bind(completed)
      .run();

    expect(await handle(request("manual", "done"), created)).toEqual({
      status: "already_processed",
      reviewRunId: completed,
      runStatus: "completed",
    });

    const failed = runIdOf(await handle(request("opened", "broken"), created));

    await failRun(failed, "gemini_error");

    expect(await handle(request("synchronize", "broken"), created)).toEqual({
      status: "already_processed",
      reviewRunId: failed,
      runStatus: "failed",
    });
    expect(await findingCount(failed)).toBe(1);
  });

  it("starts one retry when two arrive together", async () => {
    const created: string[] = [];
    const first = runIdOf(await handle(request("opened"), created));

    await failRun(first, "stuck");

    const results = await Promise.all([
      handle(request("manual"), created),
      handle(request("manual"), created),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_processed",
      "queued",
    ]);
    expect((await runRow(first))?.["attempt"]).toBe(2);
    expect(created).toHaveLength(2);
    expect(await retryCount()).toBe(1);
  });

  it("counts retries toward the daily review cap", async () => {
    const created: string[] = [];
    const run = runIdOf(await handle(request("opened"), created, 2));

    await failRun(run, "post_review_error");
    expect((await handle(request("manual"), created, 2)).status).toBe("queued");

    await failRun(run, "post_review_error");
    expect(await handle(request("manual"), created, 2)).toEqual({
      status: "rate_limited",
    });
    expect(created).toHaveLength(2);
  });

  it("checks a retried run's own workflow when looking for stuck reviews", async () => {
    const run = await Effect.runPromise(
      ReviewRunRepository.create({
        repositoryId: 1,
        pullRequestNumber: 42,
        headSha: "retried",
        trigger: "manual",
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'running', attempt = 2, updated_at = ? WHERE id = ?",
    )
      .bind(Date.now() - STUCK_AFTER_MILLIS - 60_000, run.id)
      .run();

    const result = await Effect.runPromise(
      recoverStuckRuns.pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(
          Layer.succeed(
            ReviewWorkflowStatus,
            ReviewWorkflowStatus.of({
              status: (instanceId) =>
                Effect.succeed(
                  instanceId === workflowInstanceId(run.id, 2)
                    ? Option.some("running")
                    : Option.none(),
                ),
            }),
          ),
        ),
      ),
    );

    expect(result.recovered).toBe(0);
    expect((await runRow(run.id))?.["status"]).toBe("running");
  });
});

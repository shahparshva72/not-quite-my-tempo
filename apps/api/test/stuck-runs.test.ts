import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import app from "../src/index";
import {
  recoverStuckRuns,
  ReviewWorkflowStatus,
  STUCK_AFTER_MILLIS,
  WorkflowStatusUnavailableError,
} from "../src/application/stuck-runs";
import { resetAndSeedRepository } from "./database";

const db = () => makeLiveLayer(env.DB);

const longAgo = () => Date.now() - STUCK_AFTER_MILLIS - 60_000;

const seedRun = async (headSha: string, status: string, updatedAt: number) => {
  const run = await Effect.runPromise(
    ReviewRunRepository.create({
      repositoryId: 1,
      pullRequestNumber: 42,
      headSha,
      trigger: "opened",
    }).pipe(Effect.provide(db())),
  );

  await env.DB.prepare(
    "UPDATE review_runs SET status = ?, updated_at = ? WHERE id = ?",
  )
    .bind(status, updatedAt, run.id)
    .run();

  return run.id;
};

const runState = (id: number) =>
  env.DB.prepare("SELECT status, error_code FROM review_runs WHERE id = ?")
    .bind(id)
    .first<{ status: string; error_code: string | null }>();

// Workflow statuses by instance ID; missing IDs have no instance.
const recover = (statuses: Record<string, string>) =>
  Effect.runPromise(
    recoverStuckRuns.pipe(
      Effect.provide(db()),
      Effect.provide(
        Layer.succeed(
          ReviewWorkflowStatus,
          ReviewWorkflowStatus.of({
            status: (instanceId) =>
              Effect.succeed(Option.fromNullable(statuses[instanceId])),
          }),
        ),
      ),
    ),
  );

describe("stuck review recovery", () => {
  beforeEach(resetAndSeedRepository);

  it("fails runs whose workflow errored, vanished, or finished without them", async () => {
    const errored = await seedRun("errored", "running", longAgo());
    const missing = await seedRun("missing", "queued", longAgo());
    const finished = await seedRun("finished", "running", longAgo());

    const result = await recover({
      [`review-run-${errored}`]: "errored",
      [`review-run-${finished}`]: "complete",
    });

    expect(result).toEqual({ checked: 3, recovered: 3, skipped: 0 });

    for (const id of [errored, missing, finished]) {
      expect(await runState(id)).toEqual({
        status: "failed",
        error_code: "stuck",
      });
    }
  });

  it("leaves a run alone when Cloudflare can't say what its workflow is doing", async () => {
    const id = await seedRun("unknown", "running", longAgo());

    const result = await Effect.runPromise(
      recoverStuckRuns.pipe(
        Effect.provide(db()),
        Effect.provide(
          Layer.succeed(
            ReviewWorkflowStatus,
            ReviewWorkflowStatus.of({
              status: () =>
                new WorkflowStatusUnavailableError({ cause: "503 from API" }),
            }),
          ),
        ),
      ),
    );

    expect(result).toEqual({ checked: 1, recovered: 0, skipped: 1 });
    expect(await runState(id)).toEqual({ status: "running", error_code: null });
  });

  it("leaves runs whose workflow is still making progress", async () => {
    const running = await seedRun("running", "running", longAgo());

    const result = await recover({ [`review-run-${running}`]: "running" });

    expect(result.recovered).toBe(0);
    expect(await runState(running)).toEqual({
      status: "running",
      error_code: null,
    });
  });

  it("ignores recent and finished runs", async () => {
    const recent = await seedRun("recent", "running", Date.now());
    const done = await seedRun("done", "completed", longAgo());

    const result = await recover({});

    expect(result.checked).toBe(0);
    expect((await runState(recent))?.status).toBe("running");
    expect((await runState(done))?.status).toBe("completed");
  });

  it("can't overwrite a run that finished after it was listed", async () => {
    const id = await seedRun("late", "running", longAgo());

    await env.DB.prepare(
      "UPDATE review_runs SET status = 'completed' WHERE id = ?",
    )
      .bind(id)
      .run();

    const changed = await Effect.runPromise(
      ReviewRunRepository.markStuckFailed(
        id,
        new Date(Date.now() - STUCK_AFTER_MILLIS),
        "late",
      ).pipe(Effect.provide(db())),
    );

    expect(changed).toBe(false);
    expect((await runState(id))?.status).toBe("completed");
  });

  it("is wired to the Worker's cron trigger", () => {
    expect(app.scheduled).toBeInstanceOf(Function);
  });
});

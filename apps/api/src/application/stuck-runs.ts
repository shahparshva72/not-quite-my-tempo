import { Clock, Context, Data, Effect, Either, Layer, Option } from "effect";
import { ReviewRunRepository } from "@not-quite-my-tempo/db";

import { logInfo } from "../logging.js";
import { workflowInstanceId } from "./review-requests.js";
import type { ReviewWorkflowParams } from "./review-requests.js";

/** A run unchanged for this long while queued or running is checked. */
export const STUCK_AFTER_MILLIS = 30 * 60 * 1000;

/**
 * A workflow still reporting itself live this long after its run last
 * changed is hung, not slow: the review step's three attempts take at most
 * ~32 minutes. Cloudflare has left a retried step "running" for hours past
 * its own timeout, so the instance is terminated and the run failed.
 */
export const ABANDONED_AFTER_MILLIS = 2 * 60 * 60 * 1000;

const BATCH_SIZE = 50;

// Workflow states that will still make progress on their own.
const liveStatuses = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** Cloudflare couldn't say what the instance is doing, or stop it. */
export class WorkflowStatusUnavailableError extends Data.TaggedError(
  "WorkflowStatusUnavailableError",
)<{
  readonly cause: unknown;
}> {}

export interface ReviewWorkflowStatusService {
  /**
   * The instance's status, or None only when Cloudflare says it doesn't
   * exist. Any other failure is WorkflowStatusUnavailableError, so a
   * transient error is never mistaken for a dead workflow.
   */
  readonly status: (
    instanceId: string,
  ) => Effect.Effect<Option.Option<string>, WorkflowStatusUnavailableError>;
  /** Stops the instance; one that doesn't exist counts as stopped. */
  readonly terminate: (
    instanceId: string,
  ) => Effect.Effect<void, WorkflowStatusUnavailableError>;
}

// What Workflow.get() rejects with for an unknown instance ID (checked
// against the Workflows runtime).
const isInstanceNotFound = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("instance.not_found");

export class ReviewWorkflowStatus extends Context.Tag(
  "@not-quite-my-tempo/api/ReviewWorkflowStatus",
)<ReviewWorkflowStatus, ReviewWorkflowStatusService>() {}

export const ReviewWorkflowStatusLive = (
  workflow: Workflow<ReviewWorkflowParams>,
) =>
  Layer.succeed(
    ReviewWorkflowStatus,
    ReviewWorkflowStatus.of({
      status: (instanceId) =>
        Effect.tryPromise({
          try: async () => {
            const instance = await workflow.get(instanceId);

            return Option.some((await instance.status()).status);
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            isInstanceNotFound(cause)
              ? Effect.succeed(Option.none<string>())
              : new WorkflowStatusUnavailableError({ cause }),
          ),
        ),
      terminate: (instanceId) =>
        Effect.tryPromise({
          try: async () => {
            const instance = await workflow.get(instanceId);

            await instance.terminate();
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            isInstanceNotFound(cause)
              ? Effect.void
              : new WorkflowStatusUnavailableError({ cause }),
          ),
        ),
    }),
  );

/**
 * Finds reviews stuck in queued/running and fails the ones whose workflow
 * can no longer finish them: missing, errored, terminated, or complete
 * without having updated the run. A workflow still live past
 * ABANDONED_AFTER_MILLIS is terminated first. They get error code `stuck`;
 * people retry with `/fletcher again`. Nothing is posted to GitHub, so this
 * can't duplicate a review.
 */
export const recoverStuckRuns = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const before = new Date(now - STUCK_AFTER_MILLIS);
  const abandonedBefore = now - ABANDONED_AFTER_MILLIS;
  const workflows = yield* ReviewWorkflowStatus;

  const candidates = yield* ReviewRunRepository.listStuck(before, BATCH_SIZE);

  let recovered = 0;
  let terminated = 0;
  let skipped = 0;

  for (const run of candidates) {
    const instanceId = workflowInstanceId(run.id, run.attempt);
    const status = yield* workflows.status(instanceId).pipe(Effect.either);

    // Unknown is not dead: leave the run for the next check.
    if (Either.isLeft(status)) {
      skipped += 1;
      continue;
    }

    const workflowStatus = Option.getOrElse(status.right, () => "missing");
    let errorMessage = `Workflow ${workflowStatus} without finishing the run`;

    if (liveStatuses.has(workflowStatus)) {
      if (run.updatedAt.getTime() >= abandonedBefore) {
        continue;
      }

      // Failing the run while its workflow could still post a review
      // would leave both, so a failed terminate leaves the run as it is.
      const stopped = yield* workflows
        .terminate(instanceId)
        .pipe(Effect.either);

      if (Either.isLeft(stopped)) {
        skipped += 1;
        continue;
      }

      terminated += 1;
      errorMessage = `Workflow still ${workflowStatus} after ${ABANDONED_AFTER_MILLIS / 3_600_000} hours; terminated`;

      yield* logInfo("stuck_run_workflow_terminated", {
        reviewRunId: run.id,
        workflowInstanceId: instanceId,
        workflowStatus,
      });
    }

    const changed = yield* ReviewRunRepository.markStuckFailed(
      run.id,
      before,
      errorMessage,
    );

    if (changed) {
      recovered += 1;
    }
  }

  yield* logInfo("stuck_runs_checked", {
    checked: candidates.length,
    recovered,
    terminated,
    skipped,
  });

  return { checked: candidates.length, recovered, terminated, skipped };
});

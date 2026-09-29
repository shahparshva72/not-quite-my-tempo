import { Clock, Context, Data, Effect, Either, Layer, Option } from "effect";
import { ReviewRunRepository } from "@not-quite-my-tempo/db";

import { logInfo } from "../logging.js";
import { workflowInstanceId } from "./review-requests.js";
import type { ReviewWorkflowParams } from "./review-requests.js";

/** A run unchanged for this long while queued or running is checked. */
export const STUCK_AFTER_MILLIS = 30 * 60 * 1000;

const BATCH_SIZE = 50;

// Workflow states that will still make progress on their own.
const liveStatuses = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** Cloudflare couldn't say what the instance is doing right now. */
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
    }),
  );

/**
 * Finds reviews stuck in queued/running and fails the ones whose workflow
 * can no longer finish them: missing, errored, terminated, or complete
 * without having updated the run. They get error code `stuck`; people retry
 * with `/fletcher again`. Nothing is posted to GitHub, so this can't
 * duplicate a review.
 */
export const recoverStuckRuns = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const before = new Date(now - STUCK_AFTER_MILLIS);
  const workflows = yield* ReviewWorkflowStatus;

  const candidates = yield* ReviewRunRepository.listStuck(before, BATCH_SIZE);

  let recovered = 0;
  let skipped = 0;

  for (const run of candidates) {
    const status = yield* workflows
      .status(workflowInstanceId(run.id, run.attempt))
      .pipe(Effect.either);

    // Unknown is not dead: leave the run for the next check.
    if (Either.isLeft(status)) {
      skipped += 1;
      continue;
    }

    if (Option.isSome(status.right) && liveStatuses.has(status.right.value)) {
      continue;
    }

    const changed = yield* ReviewRunRepository.markStuckFailed(
      run.id,
      before,
      `Workflow ${Option.getOrElse(status.right, () => "missing")} without finishing the run`,
    );

    if (changed) {
      recovered += 1;
    }
  }

  yield* logInfo("stuck_runs_checked", {
    checked: candidates.length,
    recovered,
    skipped,
  });

  return { checked: candidates.length, recovered, skipped };
});

import { Clock, Context, Effect, Layer, Option } from "effect";
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

export interface ReviewWorkflowStatusService {
  /** The instance's status, or None when Cloudflare has no such instance. */
  readonly status: (instanceId: string) => Effect.Effect<Option.Option<string>>;
}

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
        Effect.tryPromise(async () => {
          const instance = await workflow.get(instanceId);

          return (await instance.status()).status;
        }).pipe(
          Effect.map(Option.some),
          // get() rejects for unknown instances; treat as gone.
          Effect.orElseSucceed(() => Option.none<string>()),
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

  for (const run of candidates) {
    const status = yield* workflows.status(
      workflowInstanceId(run.id, run.attempt),
    );

    if (Option.isSome(status) && liveStatuses.has(status.value)) {
      continue;
    }

    const changed = yield* ReviewRunRepository.markStuckFailed(
      run.id,
      before,
      `Workflow ${Option.getOrElse(status, () => "missing")} without finishing the run`,
    );

    if (changed) {
      recovered += 1;
    }
  }

  yield* logInfo("stuck_runs_checked", {
    checked: candidates.length,
    recovered,
  });

  return { checked: candidates.length, recovered };
});

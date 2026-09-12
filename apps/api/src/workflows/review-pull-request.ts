import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Data, Effect, Inspectable, Schema } from "effect";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import {
  markReviewCompleted,
  markReviewFailed,
  markReviewRunning,
  performFakeReview,
} from "../application/review-workflow.js";
import { ReviewWorkflowParams } from "../application/review-requests.js";
import { logError, logInfo } from "../logging.js";

type WorkflowEnv = {
  readonly DB: D1Database;
};

class WorkflowExecutionError extends Data.TaggedError(
  "WorkflowExecutionError",
)<{
  readonly cause: unknown;
}> {}

const runStep = <A extends Rpc.Serializable<A>, E>(
  step: WorkflowStep,
  name: string,
  effect: Effect.Effect<A, E>,
) =>
  Effect.tryPromise({
    try: () => step.do(name, () => Effect.runPromise(effect)),
    catch: (cause) => new WorkflowExecutionError({ cause }),
  });

export class ReviewPullRequestWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  ReviewWorkflowParams
> {
  override run(
    event: Readonly<WorkflowEvent<ReviewWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const databaseLayer = makeLiveLayer(this.env.DB);

    const program = Effect.gen(function* () {
      const { request, reviewRunId } = yield* Schema.decodeUnknown(
        ReviewWorkflowParams,
      )(event.payload);

      const fields = {
        repository: `${request.owner}/${request.repo}`,
        pullRequestNumber: request.pullRequestNumber,
        headSha: request.headSha,
        reviewRunId,
        workflowInstanceId: event.instanceId,
      };

      const review = Effect.gen(function* () {
        yield* logInfo("review_workflow_started", fields);

        yield* runStep(
          step,
          "mark review run running",
          markReviewRunning(reviewRunId).pipe(Effect.provide(databaseLayer)),
        );

        const result = yield* runStep(
          step,
          "perform fake review",
          performFakeReview(),
        );

        yield* runStep(
          step,
          "mark review run completed",
          markReviewCompleted(reviewRunId).pipe(Effect.provide(databaseLayer)),
        );

        yield* logInfo("review_workflow_completed", fields);

        return result;
      });

      return yield* review.pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const message = Inspectable.toStringUnknown(error.cause);

            yield* logError("review_workflow_failed", {
              ...fields,
              error: message,
            });

            yield* runStep(
              step,
              "mark review run failed",
              markReviewFailed(reviewRunId, "workflow_error", message).pipe(
                Effect.provide(databaseLayer),
              ),
            );
          }),
        ),
      );
    });

    return Effect.runPromise(program);
  }
}

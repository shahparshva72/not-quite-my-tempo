import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Data, Effect, Inspectable, Match, Schema } from "effect";
import { makeLiveLayer } from "@not-quite-my-tempo/db";
import { GeminiReviewerLive } from "@not-quite-my-tempo/gemini";
import type { GeminiReviewerConfig } from "@not-quite-my-tempo/gemini";

import {
  fetchReviewablePullRequest,
  isRetryableReviewError,
  markReviewCompleted,
  markReviewFailed,
  markReviewRunning,
  mintInstallationToken,
  performGeminiReview,
  persistReviewFindings,
  postReviewToGitHub,
  reviewErrorCode,
} from "../application/review-workflow.js";
import type { ReviewPipelineError } from "../application/review-workflow.js";
import { ReviewWorkflowParams } from "../application/review-requests.js";
import { GitHubAppAuthLive } from "../github/app-auth.js";
import { GitHubPullRequestClientLive } from "../github/pull-request-client.js";
import { logError, logInfo } from "../logging.js";

type WorkflowEnv = {
  readonly DB: D1Database;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GEMINI_API_KEY: string;
  readonly GEMINI_MODEL?: string;
};

class WorkflowExecutionError extends Data.TaggedError(
  "WorkflowExecutionError",
)<{
  readonly cause: unknown;
}> {}

class ReviewStepFailure extends Data.TaggedError("ReviewStepFailure")<{
  readonly code: string;
  readonly message: string;
}> {}

type StepOutcome<A> =
  | { readonly status: "ok"; readonly value: A }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
    };

/**
 * Runs an Effect inside a durable Workflow step. Retryable failures reject
 * the step promise so Cloudflare's step retry policy re-runs them;
 * non-retryable pipeline failures are persisted as step output and surfaced
 * as a typed `ReviewStepFailure` carrying the `review_runs.error_code`.
 */
const runStep = <A extends Rpc.Serializable<A>, E extends ReviewPipelineError>(
  step: WorkflowStep,
  name: string,
  effect: Effect.Effect<A, E>,
) =>
  Effect.tryPromise({
    try: () =>
      step.do(name, () =>
        Effect.runPromise(
          effect.pipe(
            Effect.map((value): StepOutcome<A> => ({ status: "ok", value })),
            Effect.catchAll((error) =>
              isRetryableReviewError(error)
                ? Effect.fail(error)
                : Effect.succeed<StepOutcome<A>>({
                    status: "error",
                    code: reviewErrorCode(error),
                    message: Inspectable.toStringUnknown(error),
                  }),
            ),
          ),
        ),
      ),
    catch: (cause) => new WorkflowExecutionError({ cause }),
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome.status === "ok"
        ? Effect.succeed(outcome.value)
        : new ReviewStepFailure({
            code: outcome.code,
            message: outcome.message,
          }),
    ),
  );

const failureDetails = (error: WorkflowExecutionError | ReviewStepFailure) =>
  Match.value(error).pipe(
    Match.tag("ReviewStepFailure", (failure) => ({
      code: failure.code,
      message: failure.message,
    })),
    Match.tag("WorkflowExecutionError", (failure) => ({
      code: "workflow_error",
      message: Inspectable.toStringUnknown(failure.cause),
    })),
    Match.exhaustive,
  );

export class ReviewPullRequestWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  ReviewWorkflowParams
> {
  override run(
    event: Readonly<WorkflowEvent<ReviewWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const env = this.env;
    const databaseLayer = makeLiveLayer(env.DB);

    const authLayer = GitHubAppAuthLive({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });

    const geminiConfig: GeminiReviewerConfig =
      env.GEMINI_MODEL === undefined
        ? { apiKey: env.GEMINI_API_KEY }
        : { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL };

    const geminiLayer = GeminiReviewerLive(geminiConfig);
    const pullRequestLayer = GitHubPullRequestClientLive({});

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

        const installationToken = yield* runStep(
          step,
          "mint installation token",
          mintInstallationToken(request.installationId).pipe(
            Effect.provide(authLayer),
          ),
        );

        const pullRequest = yield* runStep(
          step,
          "fetch pull request",
          fetchReviewablePullRequest(installationToken, request).pipe(
            Effect.provide(pullRequestLayer),
          ),
        );

        const reviewResult = yield* runStep(
          step,
          "run gemini review",
          performGeminiReview(
            request,
            pullRequest.details,
            pullRequest.diff,
          ).pipe(Effect.provide(geminiLayer)),
        );

        const persisted = yield* runStep(
          step,
          "persist findings",
          persistReviewFindings(reviewRunId, reviewResult).pipe(
            Effect.provide(databaseLayer),
          ),
        );

        const posted = yield* runStep(
          step,
          "post github review",
          postReviewToGitHub(
            installationToken,
            request,
            reviewRunId,
            reviewResult.review,
            pullRequest.diff,
          ).pipe(
            Effect.provide(pullRequestLayer),
            Effect.provide(databaseLayer),
          ),
        );

        yield* runStep(
          step,
          "mark review run completed",
          markReviewCompleted(reviewRunId).pipe(Effect.provide(databaseLayer)),
        );

        yield* logInfo("review_workflow_completed", {
          ...fields,
          verdict: reviewResult.review.verdict,
          findingCount: persisted.findingCount,
          model: reviewResult.model,
          githubReviewId: posted.reviewId,
          inlineCommentCount: posted.inlineCommentCount,
        });

        return reviewResult.review;
      });

      return yield* review.pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const details = failureDetails(error);

            yield* logError("review_workflow_failed", {
              ...fields,
              errorCode: details.code,
              error: details.message,
            });

            yield* runStep(
              step,
              "mark review run failed",
              markReviewFailed(reviewRunId, details.code, details.message).pipe(
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

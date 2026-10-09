import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Data, Effect, Inspectable, Match, Option, Schema } from "effect";
import { makeLiveLayer } from "@not-quite-my-tempo/db";
import { ReviewerLive } from "@not-quite-my-tempo/reviewer";

import {
  fetchReviewablePullRequest,
  isRetryableReviewError,
  loadPriorReview,
  markReviewCompleted,
  markReviewFailed,
  markReviewRunning,
  mintInstallationToken,
  performGeminiReview,
  persistReviewFindings,
  postReviewToGitHub,
  reviewToneOf,
  reviewErrorCode,
} from "../application/review-workflow.js";
import type { ReviewPipelineError } from "../application/review-workflow.js";
import {
  chooseReviewKey,
  downgradeNotice,
  explainBlockedReview,
  planMonthlyCredits,
  platformVendors,
  resolveReviewKey,
  trialDailyReviewCap,
  WorkspaceReviewKeyError,
} from "../application/review-keys.js";
import type {
  BlockedReviewCode,
  PlatformKeys,
} from "../application/review-keys.js";
import { ReviewWorkflowParams } from "../application/review-requests.js";
import { polarConfig } from "../billing/polar-client.js";
import { GitHubAppAuthLive } from "../github/app-auth.js";
import { GitHubPullRequestClientLive } from "../github/pull-request-client.js";
import { logError, logInfo } from "../logging.js";

type WorkflowEnv = {
  readonly DB: D1Database;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GEMINI_API_KEY: string;
  readonly GEMINI_MODEL?: string;
  // "vertex_express" when GEMINI_API_KEY is a Vertex AI key; otherwise the
  // Gemini Developer API (Google AI Studio key).
  readonly GEMINI_API_PROVIDER?: string;
  // Optional platform keys for paid-plan reviews on GPT and Claude models.
  readonly OPENAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  // Paid-plan credits per billing period (review-keys.ts).
  readonly PLAN_MONTHLY_CREDITS?: string;
  readonly TOKEN_ENCRYPTION_KEY: string;
  // Platform-wide free trial reviews per 24 hours (review-keys.ts).
  readonly TRIAL_DAILY_REVIEW_CAP?: string;
  // Only to tell blocked pull requests whether subscribing is an option.
  readonly POLAR_ACCESS_TOKEN?: string;
  readonly POLAR_PRODUCT_ID?: string;
  readonly POLAR_WEBHOOK_SECRET?: string;
};

const blockedStepNames: Readonly<Record<BlockedReviewCode, string>> = {
  no_gemini_key: "explain missing gemini key",
  trial_paused: "explain paused trial",
  credits_exhausted: "explain used credits",
};

const blockedMessages: Readonly<Record<BlockedReviewCode, string>> = {
  no_gemini_key: "No review key and no free trial reviews left",
  trial_paused: "Free trial reviews are paused: platform daily cap reached",
  credits_exhausted:
    "No plan credits left for this period and no review key of its own",
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

    // The reviewer is built per run: the key and model depend on the
    // workspace (its own key, plan credits, or the trial). See
    // docs/MULTI_PROVIDER_BYOK_DESIGN.md.
    const platformKeys: PlatformKeys = {
      gemini: {
        apiKey: env.GEMINI_API_KEY,
        provider:
          env.GEMINI_API_PROVIDER === "vertex_express"
            ? "vertex_express"
            : "gemini_api",
      },
      openai: env.OPENAI_API_KEY ?? null,
      anthropic: env.ANTHROPIC_API_KEY ?? null,
    };

    const creditAllowance = planMonthlyCredits(env.PLAN_MONTHLY_CREDITS);

    const pullRequestLayer = GitHubPullRequestClientLive({});

    // Each step that calls GitHub mints its own installation token, so no
    // token is ever a step output (Cloudflare persists those) and a step
    // retried after an hour doesn't reuse an expired one.
    const withInstallationToken = <A, E, R>(
      installationId: number,
      use: (token: string) => Effect.Effect<A, E, R>,
    ) =>
      mintInstallationToken(installationId).pipe(
        Effect.provide(authLayer),
        Effect.flatMap(use),
      );

    const program = Effect.gen(function* () {
      const { request, reviewRunId, appOrigin } = yield* Schema.decodeUnknown(
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

        const pullRequest = yield* runStep(
          step,
          "fetch pull request",
          withInstallationToken(request.installationId, (token) =>
            fetchReviewablePullRequest(token, request),
          ).pipe(Effect.provide(pullRequestLayer)),
        );

        if (!pullRequest.config.enabled) {
          yield* runStep(
            step,
            "mark review run completed",
            markReviewCompleted(reviewRunId).pipe(
              Effect.provide(databaseLayer),
            ),
          );

          yield* logInfo("review_skipped_disabled", fields);

          return { skipped: true } as const;
        }

        const priorReview = yield* runStep(
          step,
          "load prior findings",
          loadPriorReview(reviewRunId).pipe(Effect.provide(databaseLayer)),
        );

        const keyChoice = yield* runStep(
          step,
          "choose gemini key",
          chooseReviewKey(
            reviewRunId,
            new TextEncoder().encode(pullRequest.diff).length,
            {
              allowanceX100: creditAllowance * 100,
              vendors: platformVendors(platformKeys),
              geminiProvider: platformKeys.gemini.provider,
            },
            trialDailyReviewCap(env.TRIAL_DAILY_REVIEW_CAP),
          ).pipe(Effect.provide(databaseLayer)),
        );

        const keySource = keyChoice.source;

        if (
          keySource === "none" ||
          keySource === "trial_paused" ||
          keySource === "credits_exhausted"
        ) {
          const reason: BlockedReviewCode =
            keySource === "none" ? "no_gemini_key" : keySource;

          yield* runStep(
            step,
            blockedStepNames[reason],
            withInstallationToken(request.installationId, (token) =>
              explainBlockedReview(
                token,
                request,
                reviewRunId,
                keyChoice.repositoryId,
                keyChoice.workspaceId,
                reason,
                {
                  billingEnabled: Option.isSome(polarConfig(env)),
                  creditAllowance,
                  appOrigin,
                },
              ),
            ).pipe(
              Effect.provide(pullRequestLayer),
              Effect.provide(databaseLayer),
              // The run is marked blocked whether or not GitHub hears why.
              Effect.catchAll((error) =>
                logError("blocked_review_comment_failed", {
                  reviewRunId,
                  errorCode: error._tag,
                }),
              ),
            ),
          );

          yield* runStep(
            step,
            "mark review run blocked",
            markReviewFailed(reviewRunId, reason, blockedMessages[reason]).pipe(
              Effect.provide(databaseLayer),
            ),
          );

          yield* logInfo(`review_blocked_${reason}`, fields);

          return { blocked: true } as const;
        }

        // The key is looked up and decrypted inside this step so it never
        // appears in a persisted step output.
        const reviewResult = yield* runStep(
          step,
          "run gemini review",
          resolveReviewKey(
            keyChoice,
            platformKeys,
            env.GEMINI_MODEL,
            env.TOKEN_ENCRYPTION_KEY,
          ).pipe(
            Effect.provide(databaseLayer),
            Effect.flatMap((key) =>
              performGeminiReview(request, pullRequest, priorReview).pipe(
                Effect.provide(ReviewerLive(key)),
              ),
            ),
            // Problems with a workspace's own key are the workspace's to
            // fix, so they get their own codes and messages.
            Effect.catchTag("ReviewProviderError", (error) =>
              Effect.gen(function* () {
                if (
                  keySource === "workspace" &&
                  (error.reason === "key_rejected" ||
                    error.reason === "quota_exceeded" ||
                    error.reason === "model_unavailable")
                ) {
                  return yield* new WorkspaceReviewKeyError({
                    reason: error.reason,
                    provider: error.provider,
                    status: error.status,
                  });
                }

                return yield* error;
              }),
            ),
          ),
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
          withInstallationToken(request.installationId, (token) =>
            postReviewToGitHub(
              token,
              request,
              reviewRunId,
              reviewResult.review,
              pullRequest.diff,
              reviewToneOf(pullRequest.config),
              downgradeNotice(keyChoice),
            ),
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

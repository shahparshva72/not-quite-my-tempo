import {
  Clock,
  Context,
  Data,
  Effect,
  Inspectable,
  Layer,
  Option,
  Schema,
} from "effect";
import {
  GitHubInstallationRepository,
  GitHubRepositoryRepository,
  ReviewRunCreation,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";

import { GitHubAppAuth } from "../github/app-auth.js";
import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import { ReviewRequest } from "../github/review-request.js";
import { logError, logInfo } from "../logging.js";
import type { ManualReviewCommand } from "../github/manual-command.js";

export const ReviewWorkflowParams = Schema.Struct({
  reviewRunId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  request: ReviewRequest,
  // Public origin of this Worker (from the webhook request), for links in
  // comments Fletcher posts. Optional so in-flight runs still decode.
  appOrigin: Schema.optional(Schema.String),
  // 1 for a first review; higher for "/fletcher again" retries of a failed
  // run on the same commit. Optional so in-flight runs still decode.
  attempt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
});

export type ReviewWorkflowParams = typeof ReviewWorkflowParams.Type;

/**
 * The Workflow instance ID for a run's attempt. Instance IDs can't be
 * reused, so retries get a suffix; the stuck-run check uses the same IDs.
 */
export const workflowInstanceId = (reviewRunId: number, attempt = 1) =>
  attempt === 1
    ? `review-run-${reviewRunId}`
    : `review-run-${reviewRunId}-attempt-${attempt}`;

export class WorkflowStartError extends Data.TaggedError("WorkflowStartError")<{
  readonly cause: unknown;
}> {}

export interface ReviewWorkflowService {
  readonly start: (
    params: ReviewWorkflowParams,
  ) => Effect.Effect<string, WorkflowStartError>;
}

export class ReviewWorkflow extends Context.Tag(
  "@not-quite-my-tempo/api/ReviewWorkflow",
)<ReviewWorkflow, ReviewWorkflowService>() {}

export const ReviewWorkflowLive = (
  workflow: Workflow<ReviewWorkflowParams>,
  appOrigin: string,
) =>
  Layer.succeed(
    ReviewWorkflow,
    ReviewWorkflow.of({
      start: (params) =>
        Effect.tryPromise({
          try: () =>
            workflow.create({
              id: workflowInstanceId(params.reviewRunId, params.attempt),
              params: { ...params, appOrigin },
            }),
          catch: (cause) => new WorkflowStartError({ cause }),
        }).pipe(Effect.map((instance) => instance.id)),
    }),
  );

type QueueOutcome =
  | { readonly status: "queued"; readonly reviewRunId: number }
  | { readonly status: "already_processed"; readonly reviewRunId: number };

// Per-installation cost guardrail: at most this many review runs per
// rolling 24 hours before deliveries are acknowledged without a review.
export const DAILY_REVIEW_RUN_CAP = 50;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/**
 * Handles a `/fletcher again` comment: resolves the pull request's current
 * head SHA as the GitHub App installation and enqueues a `manual` review
 * through the normal path (idempotency and the daily cap both apply). When
 * a review is queued, Fletcher reacts to the comment with 👀 so the
 * commenter knows it's under way.
 */
export const handleManualReviewCommand = ({
  commentId,
  ...command
}: ManualReviewCommand) =>
  Effect.gen(function* () {
    const auth = yield* GitHubAppAuth;
    const client = yield* GitHubPullRequestClient;

    const token = yield* auth.mintInstallationToken(command.installationId);

    const ref = {
      owner: command.owner,
      repo: command.repo,
      pullRequestNumber: command.pullRequestNumber,
    };

    const details = yield* client.fetchDetails(token.token, ref);

    const fields = {
      repository: `${command.owner}/${command.repo}`,
      pullRequestNumber: command.pullRequestNumber,
      headSha: details.headSha,
    };

    yield* logInfo("manual_review_requested", fields);

    const outcome = yield* handleReviewRequest({
      ...command,
      headSha: details.headSha,
      trigger: "manual",
    });

    // Only a queued review gets the reaction: a duplicate, rate-limited, or
    // disabled request isn't being worked on. The reaction is a courtesy,
    // so failing to add it never fails the review, and it may not hold up
    // the webhook response.
    if (outcome.status === "queued") {
      yield* client
        .createCommentReaction(token.token, ref, commentId, "eyes")
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.catchAll((error) =>
            logError("manual_review_reaction_failed", {
              ...fields,
              commentId,
              error: Inspectable.toStringUnknown(error),
            }),
          ),
        );
    }

    return outcome;
  });

export const handleReviewRequest = (
  request: ReviewRequest,
  dailyRunCap: number = DAILY_REVIEW_RUN_CAP,
) =>
  Effect.gen(function* () {
    const installation = yield* GitHubInstallationRepository.upsert({
      githubInstallationId: request.installationId,
      githubAccountId: request.installationAccountId,
      githubAccountLogin: request.owner,
      accountType: request.installationAccountType,
    });

    const repository = yield* GitHubRepositoryRepository.upsert({
      installationId: installation.id,
      githubRepositoryId: request.githubRepositoryId,
      owner: request.owner,
      name: request.repo,
      defaultBranch: request.defaultBranch,
    });

    const fields = {
      githubEvent: `pull_request.${request.trigger}`,
      repository: `${request.owner}/${request.repo}`,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
    };

    if (
      installation.status !== "active" ||
      repository.removedAt !== null ||
      !repository.enabled
    ) {
      yield* logInfo("review_skipped_inactive_repository", {
        ...fields,
        installationStatus: installation.status,
        repositoryRemoved: repository.removedAt !== null,
        repositoryEnabled: repository.enabled,
      });

      return { status: "ignored" as const };
    }

    const nowMillis = yield* Clock.currentTimeMillis;

    const recentRunCount = yield* ReviewRunRepository.countForInstallationSince(
      installation.id,
      new Date(nowMillis - DAY_MILLIS),
    );

    if (recentRunCount >= dailyRunCap) {
      yield* logInfo("review_rate_limited", {
        ...fields,
        recentRunCount,
        dailyRunCap,
      });

      return { status: "rate_limited" as const };
    }

    const result = yield* ReviewRunRepository.createOrFind({
      repositoryId: repository.id,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
      trigger: request.trigger,
    });

    const startWorkflow = (
      reviewRunId: number,
      attempt: number,
    ): Effect.Effect<QueueOutcome, WorkflowStartError, ReviewWorkflow> =>
      Effect.gen(function* () {
        const workflows = yield* ReviewWorkflow;

        const workflowInstanceId = yield* workflows
          .start({ reviewRunId, request, attempt })
          .pipe(
            Effect.tapError((error) =>
              logError("review_workflow_start_failed", {
                ...fields,
                reviewRunId,
                attempt,
                error: Inspectable.toStringUnknown(error.cause),
              }),
            ),
          );

        yield* logInfo("review_workflow_queued", {
          ...fields,
          reviewRunId,
          attempt,
          workflowInstanceId,
        });

        return { status: "queued", reviewRunId };
      });

    const alreadyProcessed = (
      reviewRunId: number,
    ): Effect.Effect<QueueOutcome> =>
      logInfo("github_webhook_duplicate", { ...fields, reviewRunId }).pipe(
        Effect.as({ status: "already_processed", reviewRunId }),
      );

    return yield* ReviewRunCreation.$match(result, {
      // "/fletcher again" on a commit whose review failed (blocked for a
      // missing key, Gemini down, stuck, ...) retries it; any other repeat
      // delivery for the same commit is a duplicate.
      Existing: ({ reviewRun }) =>
        request.trigger === "manual" && reviewRun.status === "failed"
          ? ReviewRunRepository.requeueFailed(reviewRun.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => alreadyProcessed(reviewRun.id),
                  onSome: (requeued) =>
                    startWorkflow(requeued.id, requeued.attempt),
                }),
              ),
            )
          : alreadyProcessed(reviewRun.id),
      Created: ({ reviewRun }) =>
        startWorkflow(reviewRun.id, reviewRun.attempt),
    });
  });

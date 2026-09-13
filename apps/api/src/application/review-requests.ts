import {
  Clock,
  Context,
  Data,
  Effect,
  Inspectable,
  Layer,
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
});

export type ReviewWorkflowParams = typeof ReviewWorkflowParams.Type;

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

export const ReviewWorkflowLive = (workflow: Workflow<ReviewWorkflowParams>) =>
  Layer.succeed(
    ReviewWorkflow,
    ReviewWorkflow.of({
      start: (params) =>
        Effect.tryPromise({
          try: () =>
            workflow.create({
              id: `review-run-${params.reviewRunId}`,
              params,
            }),
          catch: (cause) => new WorkflowStartError({ cause }),
        }).pipe(Effect.map((instance) => instance.id)),
    }),
  );

// Per-installation cost guardrail: at most this many review runs per
// rolling 24 hours before deliveries are acknowledged without a review.
export const DAILY_REVIEW_RUN_CAP = 50;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/**
 * Handles a `/fletcher again` comment: resolves the pull request's current
 * head SHA as the GitHub App installation and enqueues a `manual` review
 * through the normal path (idempotency and the daily cap both apply).
 */
export const handleManualReviewCommand = (command: ManualReviewCommand) =>
  Effect.gen(function* () {
    const auth = yield* GitHubAppAuth;
    const client = yield* GitHubPullRequestClient;

    const token = yield* auth.mintInstallationToken(command.installationId);

    const details = yield* client.fetchDetails(token.token, {
      owner: command.owner,
      repo: command.repo,
      pullRequestNumber: command.pullRequestNumber,
    });

    yield* logInfo("manual_review_requested", {
      repository: `${command.owner}/${command.repo}`,
      pullRequestNumber: command.pullRequestNumber,
      headSha: details.headSha,
    });

    return yield* handleReviewRequest({
      ...command,
      headSha: details.headSha,
      trigger: "manual",
    });
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

    return yield* ReviewRunCreation.$match(result, {
      Existing: ({ reviewRun }) =>
        logInfo("github_webhook_duplicate", {
          ...fields,
          reviewRunId: reviewRun.id,
        }).pipe(
          Effect.as({
            status: "already_processed" as const,
            reviewRunId: reviewRun.id,
          }),
        ),
      Created: ({ reviewRun }) =>
        Effect.gen(function* () {
          const workflows = yield* ReviewWorkflow;

          const workflowInstanceId = yield* workflows
            .start({ reviewRunId: reviewRun.id, request })
            .pipe(
              Effect.tapError((error) =>
                logError("review_workflow_start_failed", {
                  ...fields,
                  reviewRunId: reviewRun.id,
                  error: Inspectable.toStringUnknown(error.cause),
                }),
              ),
            );

          yield* logInfo("review_workflow_queued", {
            ...fields,
            reviewRunId: reviewRun.id,
            workflowInstanceId,
          });

          return { status: "queued" as const, reviewRunId: reviewRun.id };
        }),
    });
  });

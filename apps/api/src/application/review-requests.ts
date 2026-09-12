import { Context, Data, Effect, Inspectable, Layer, Schema } from "effect";
import {
  GitHubInstallationRepository,
  GitHubRepositoryRepository,
  ReviewRunCreation,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";

import { ReviewRequest } from "../github/review-request.js";
import { logError, logInfo } from "../logging.js";

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

export const enqueueReviewRequest = (request: ReviewRequest) =>
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

    return yield* ReviewRunRepository.createOrFind({
      repositoryId: repository.id,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
      trigger: request.trigger,
    });
  });

export const handleReviewRequest = (request: ReviewRequest) =>
  Effect.gen(function* () {
    const result = yield* enqueueReviewRequest(request);

    const fields = {
      githubEvent: `pull_request.${request.trigger}`,
      repository: `${request.owner}/${request.repo}`,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
    };

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

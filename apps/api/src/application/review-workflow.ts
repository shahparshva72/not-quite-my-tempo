import { Data, Effect, Match } from "effect";
import { Schema } from "effect";
import {
  commentableLinesByFile,
  defaultReviewConfig,
  filterUnifiedDiff,
  parseUnifiedDiff,
  REVIEW_CONFIG_PATH,
  ReviewConfig,
} from "@not-quite-my-tempo/core";
import { FindingRepository, ReviewRunRepository } from "@not-quite-my-tempo/db";
import {
  filterReviewBySeverity,
  GeminiReviewer,
} from "@not-quite-my-tempo/gemini";
import type { DatabaseError, Finding, ReviewRun } from "@not-quite-my-tempo/db";
import type { GeminiReview, PriorReview } from "@not-quite-my-tempo/gemini";
import type {
  GeminiReviewerError,
  GeminiReviewResult,
} from "@not-quite-my-tempo/gemini";
import { Option } from "effect";

import { GitHubAppAuth } from "../github/app-auth.js";
import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import type { GitHubAppAuthError } from "../github/app-auth.js";
import type {
  PullRequestClientError,
  PullRequestDetails,
  PostedReviewComment,
  ReviewSubmitError,
} from "../github/pull-request-client.js";
import type { ReviewRequest } from "../github/review-request.js";
import { logError } from "../logging.js";
import {
  buildFindingCommentBody,
  buildReviewSummaryBody,
} from "./review-presentation.js";

export class ReviewRunNotFoundError extends Data.TaggedError(
  "ReviewRunNotFoundError",
)<{
  readonly reviewRunId: number;
}> {}

export type ReviewPipelineError =
  | GitHubAppAuthError
  | PullRequestClientError
  | ReviewSubmitError
  | GeminiReviewerError
  | DatabaseError
  | ReviewRunNotFoundError;

/**
 * Maps a review pipeline failure to the stable `review_runs.error_code`
 * taxonomy used by operational queries.
 */
export const reviewErrorCode = (error: ReviewPipelineError): string =>
  Match.value(error).pipe(
    Match.tag("GitHubAppJwtError", () => "github_auth_error"),
    Match.tag("GitHubApiRequestError", () => "github_auth_error"),
    Match.tag("GitHubInstallationTokenError", () => "github_auth_error"),
    Match.tag("PullRequestRequestError", () => "diff_fetch_error"),
    Match.tag("PullRequestResponseError", () => "diff_fetch_error"),
    Match.tag("PullRequestDiffTooLargeError", () => "diff_too_large"),
    Match.tag("ReviewSubmitRequestError", () => "post_review_error"),
    Match.tag("ReviewSubmitResponseError", () => "post_review_error"),
    Match.tag("GeminiRequestError", () => "gemini_error"),
    Match.tag("GeminiResponseError", () => "gemini_error"),
    Match.tag("GeminiResponseParseError", () => "gemini_error"),
    Match.tag("GeminiTimeoutError", () => "gemini_error"),
    Match.tag("DatabaseError", () => "db_error"),
    Match.tag("ReviewRunNotFoundError", () => "review_run_not_found"),
    Match.exhaustive,
  );

/**
 * Transient failures worth re-running a durable Workflow step for. The
 * Gemini client already retries 429/5xx internally, so its errors are final
 * here.
 */
export const isRetryableReviewError = (error: ReviewPipelineError): boolean =>
  Match.value(error).pipe(
    Match.tag("GitHubApiRequestError", () => true),
    Match.tag(
      "GitHubInstallationTokenError",
      (failure) => failure.status === 429 || failure.status >= 500,
    ),
    Match.tag("PullRequestRequestError", () => true),
    Match.tag(
      "PullRequestResponseError",
      (failure) => failure.status === 429 || failure.status >= 500,
    ),
    Match.tag("DatabaseError", () => true),
    Match.orElse(() => false),
  );

const requireReviewRun = (
  reviewRunId: number,
  reviewRun: Effect.Effect<
    Option.Option<ReviewRun>,
    DatabaseError,
    ReviewRunRepository
  >,
) =>
  reviewRun.pipe(
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => new ReviewRunNotFoundError({ reviewRunId }),
    ),
  );

export const markReviewRunning = (reviewRunId: number) =>
  requireReviewRun(reviewRunId, ReviewRunRepository.markRunning(reviewRunId));

export const markReviewCompleted = (reviewRunId: number) =>
  requireReviewRun(reviewRunId, ReviewRunRepository.markCompleted(reviewRunId));

export const markReviewFailed = (
  reviewRunId: number,
  errorCode: string,
  errorMessage: string,
) =>
  requireReviewRun(
    reviewRunId,
    ReviewRunRepository.markFailed(reviewRunId, errorCode, errorMessage),
  );

export const mintInstallationToken = (installationId: number) =>
  Effect.gen(function* () {
    const auth = yield* GitHubAppAuth;
    const token = yield* auth.mintInstallationToken(installationId);

    return token.token;
  });

export interface ReviewablePullRequest {
  readonly details: PullRequestDetails;
  readonly diff: string;
  readonly config: ReviewConfig;
}

const resolveReviewConfig = (content: Option.Option<string>) =>
  Option.match(content, {
    onNone: () => Effect.succeed(defaultReviewConfig),
    onSome: (json) =>
      Schema.decodeUnknown(Schema.parseJson(ReviewConfig))(json).pipe(
        Effect.catchTag("ParseError", (error) =>
          logError("invalid_review_config", {
            path: REVIEW_CONFIG_PATH,
            error: error.message,
          }).pipe(Effect.as(defaultReviewConfig)),
        ),
      ),
  });

export const fetchReviewablePullRequest = (
  installationToken: string,
  request: ReviewRequest,
) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;

    const ref = {
      owner: request.owner,
      repo: request.repo,
      pullRequestNumber: request.pullRequestNumber,
    };

    const details = yield* client.fetchDetails(installationToken, ref);

    const configFile = yield* client.fetchRepositoryFile(
      installationToken,
      ref,
      REVIEW_CONFIG_PATH,
      request.headSha,
    );

    const config = yield* resolveReviewConfig(configFile);
    const diff = yield* client.fetchDiff(installationToken, ref);

    const result: ReviewablePullRequest = {
      details,
      config,
      diff: filterUnifiedDiff(diff, config.ignore),
    };

    return result;
  });

/**
 * Loads the findings of the most recent completed review of the same pull
 * request (if any), slimmed down for the Gemini prompt. This gives the
 * reviewer memory across `synchronize` pushes.
 */
export const loadPriorReview = (
  reviewRunId: number,
): Effect.Effect<
  PriorReview | null,
  DatabaseError | ReviewRunNotFoundError,
  ReviewRunRepository | FindingRepository
> =>
  Effect.gen(function* () {
    const currentRun = yield* requireReviewRun(
      reviewRunId,
      ReviewRunRepository.findById(reviewRunId),
    );

    const priorRun =
      yield* ReviewRunRepository.findLatestCompletedForPullRequest(
        currentRun.repositoryId,
        currentRun.pullRequestNumber,
        reviewRunId,
      );

    return yield* Option.match(priorRun, {
      onNone: () => Effect.succeed(null),
      onSome: (run) =>
        FindingRepository.listByReviewRun(run.id).pipe(
          Effect.map((findings): PriorReview => ({
            headSha: run.headSha,
            findings: findings.map((finding) => ({
              filePath: finding.filePath,
              line: finding.line,
              severity: finding.severity,
              title: finding.title,
              message: finding.message,
            })),
          })),
        ),
    });
  });

export const performGeminiReview = (
  request: ReviewRequest,
  pullRequest: ReviewablePullRequest,
  priorReview: PriorReview | null,
) =>
  Effect.gen(function* () {
    const reviewer = yield* GeminiReviewer;

    const result = yield* reviewer.review({
      repository: `${request.owner}/${request.repo}`,
      pullRequestNumber: request.pullRequestNumber,
      title: pullRequest.details.title,
      body: pullRequest.details.body,
      diff: pullRequest.diff,
      priorReview,
      intensity: pullRequest.config.intensity,
    });

    return {
      ...result,
      review: filterReviewBySeverity(
        result.review,
        pullRequest.config.severityThreshold,
      ),
    };
  });

export const persistReviewFindings = (
  reviewRunId: number,
  result: GeminiReviewResult,
) =>
  Effect.gen(function* () {
    yield* requireReviewRun(
      reviewRunId,
      ReviewRunRepository.recordModelUsage(
        reviewRunId,
        result.model,
        result.usage,
      ),
    );

    const findings = yield* FindingRepository.insertMany(
      reviewRunId,
      result.review.findings.map((finding) => ({
        filePath: finding.filePath,
        line: finding.line,
        severity: finding.severity,
        category: finding.category,
        confidence: finding.confidence,
        title: finding.title,
        message: finding.message,
      })),
    );

    return { findingCount: findings.length };
  });

interface AnchoredFinding {
  readonly finding: Finding;
  readonly line: number;
}

const splitByAnchorability = (
  findings: readonly Finding[],
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
) => {
  const anchored: AnchoredFinding[] = [];
  const unanchored: Finding[] = [];

  for (const finding of findings) {
    const lines = commentable.get(finding.filePath);

    if (
      finding.line !== null &&
      lines !== undefined &&
      lines.has(finding.line)
    ) {
      anchored.push({ finding, line: finding.line });
    } else {
      unanchored.push(finding);
    }
  }

  return { anchored, unanchored };
};

/**
 * Posts the persisted review to GitHub as a `COMMENT` review: the Fletcher
 * summary as the review body, findings that anchor to added lines as inline
 * comments, and the rest folded into the summary. Posted comment IDs are
 * written back to `findings.github_comment_id`.
 */
export const postReviewToGitHub = (
  installationToken: string,
  request: ReviewRequest,
  reviewRunId: number,
  review: GeminiReview,
  diff: string,
) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;
    const findings = yield* FindingRepository.listByReviewRun(reviewRunId);

    const { anchored, unanchored } = splitByAnchorability(
      findings,
      commentableLinesByFile(parseUnifiedDiff(diff)),
    );

    const ref = {
      owner: request.owner,
      repo: request.repo,
      pullRequestNumber: request.pullRequestNumber,
    };

    const created = yield* client.createReview(installationToken, ref, {
      commitId: request.headSha,
      body: buildReviewSummaryBody(review, findings, unanchored),
      comments: anchored.map(({ finding, line }) => ({
        path: finding.filePath,
        line,
        body: buildFindingCommentBody(finding),
      })),
    });

    const listPostedComments = (
      attemptsRemaining: number,
    ): Effect.Effect<readonly PostedReviewComment[], ReviewSubmitError> =>
      client
        .listReviewComments(installationToken, ref, created.reviewId)
        .pipe(
          Effect.flatMap((comments) =>
            comments.length >= anchored.length || attemptsRemaining === 1
              ? Effect.succeed(comments)
              : Effect.sleep("250 millis").pipe(
                  Effect.flatMap(() =>
                    listPostedComments(attemptsRemaining - 1),
                  ),
                ),
          ),
        );

    const postedComments =
      anchored.length === 0 ? [] : yield* listPostedComments(3);

    yield* Effect.forEach(
      postedComments,
      (comment) => {
        const match = anchored.find(
          ({ finding, line }) =>
            finding.filePath === comment.path &&
            line === comment.line &&
            buildFindingCommentBody(finding) === comment.body,
        );

        return match === undefined
          ? Effect.void
          : FindingRepository.setGithubCommentId(match.finding.id, comment.id);
      },
      { discard: true },
    );

    return {
      reviewId: created.reviewId,
      inlineCommentCount: anchored.length,
      summaryFindingCount: unanchored.length,
    };
  });

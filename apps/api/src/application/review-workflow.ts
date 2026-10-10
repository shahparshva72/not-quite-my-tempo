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
import {
  FindingRepository,
  GitHubRepositoryRepository,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import {
  filterReviewBySeverity,
  findCatalogModel,
  reviewCostUsdMicros,
  Reviewer,
} from "@not-quite-my-tempo/reviewer";
import type { DatabaseError, Finding, ReviewRun } from "@not-quite-my-tempo/db";
import type {
  GeminiReview,
  PriorReview,
  RepositoryContext,
  ReviewTone,
} from "@not-quite-my-tempo/reviewer";
import type { ReviewerError, ReviewResult } from "@not-quite-my-tempo/reviewer";
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
import type {
  GeminiKeyUnreadableError,
  PlatformKeyMissingError,
  WorkspaceReviewKeyError,
} from "./review-keys.js";
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
  | ReviewerError
  | DatabaseError
  | ReviewRunNotFoundError
  | GeminiKeyUnreadableError
  | WorkspaceReviewKeyError
  | PlatformKeyMissingError;

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
    Match.tag("ReviewProviderError", () => "review_error"),
    Match.tag("ReviewOutputInvalidError", () => "review_output_invalid"),
    Match.tag("ReviewTimeoutError", () => "review_error"),
    Match.tag("DatabaseError", () => "db_error"),
    Match.tag("ReviewRunNotFoundError", () => "review_run_not_found"),
    Match.tag("GeminiKeyUnreadableError", () => "review_key_unreadable"),
    Match.tag("PlatformKeyMissingError", () => "review_error"),
    Match.tag("WorkspaceReviewKeyError", (error) =>
      Match.value(error.reason).pipe(
        Match.when("key_rejected", () => "review_key_rejected"),
        Match.when("quota_exceeded", () => "review_quota_exceeded"),
        Match.when("model_unavailable", () => "review_model_unavailable"),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

/**
 * Transient failures worth re-running a durable Workflow step for. The
 * reviewer retries quick 429/5xx answers itself; timeouts and overloads
 * that outlast that are retried by the review step's own policy
 * (REVIEW_STEP_RETRY in workflows/review-pull-request.ts), so they are
 * not listed here.
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

/**
 * A review config as a Workflow step output may hold it. The fetched pull
 * request is persisted, so a run that fetched it before `tone` or
 * `guidelines` existed resumes without them.
 */
export type PersistedReviewConfig = Omit<
  ReviewConfig,
  "tone" | "guidelines"
> & {
  readonly tone?: ReviewTone | undefined;
  readonly guidelines?: readonly string[] | null | undefined;
};

export interface ReviewablePullRequest {
  readonly details: PullRequestDetails;
  readonly diff: string;
  readonly config: PersistedReviewConfig;
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

/**
 * The tone an admin picked for the run's repository on the dashboard, or
 * null to follow its .fletcher.json.
 */
export const repositoryReviewTone = (reviewRunId: number) =>
  Effect.gen(function* () {
    const run = yield* requireReviewRun(
      reviewRunId,
      ReviewRunRepository.findById(reviewRunId),
    );

    const repository = yield* GitHubRepositoryRepository.findById(
      run.repositoryId,
    );

    return repository.pipe(
      Option.flatMapNullable((found) => found.reviewTone),
      Option.getOrNull,
    );
  });

/**
 * Fetches the pull request, its .fletcher.json, and its filtered diff. A
 * dashboard tone (`toneOverride`) wins over the file's.
 */
export const fetchReviewablePullRequest = (
  installationToken: string,
  request: ReviewRequest,
  toneOverride: ReviewTone | null = null,
) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;

    const ref = {
      owner: request.owner,
      repo: request.repo,
      pullRequestNumber: request.pullRequestNumber,
    };

    const details = yield* client.fetchDetails(installationToken, ref);

    // Read from the default branch, never the pull request: its author
    // must not be able to switch the review off or hide files from it.
    const configFile = yield* client.fetchRepositoryFile(
      installationToken,
      ref,
      REVIEW_CONFIG_PATH,
      request.defaultBranch,
    );

    const fileConfig = yield* resolveReviewConfig(configFile);

    const config =
      toneOverride === null
        ? fileConfig
        : { ...fileConfig, tone: toneOverride };

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

/** The pull request's review tone; the standard one when none was saved. */
export const reviewToneOf = (config: PersistedReviewConfig): ReviewTone =>
  config.tone ?? "standard";

export const performGeminiReview = (
  request: ReviewRequest,
  pullRequest: ReviewablePullRequest,
  priorReview: PriorReview | null,
  context: RepositoryContext | null,
) =>
  Effect.gen(function* () {
    const reviewer = yield* Reviewer;

    const result = yield* reviewer.review({
      repository: `${request.owner}/${request.repo}`,
      pullRequestNumber: request.pullRequestNumber,
      title: pullRequest.details.title,
      body: pullRequest.details.body,
      diff: pullRequest.diff,
      priorReview,
      context,
      intensity: pullRequest.config.intensity,
      tone: reviewToneOf(pullRequest.config),
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
  result: ReviewResult,
) =>
  Effect.gen(function* () {
    yield* requireReviewRun(
      reviewRunId,
      ReviewRunRepository.recordReviewResult(reviewRunId, {
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        costUsdMicros: Option.match(
          Option.fromNullable(findCatalogModel(result.model)),
          {
            onNone: () => null,
            onSome: (model) =>
              reviewCostUsdMicros(
                model,
                result.usage.inputTokens,
                result.usage.outputTokens,
                result.usage.cachedInputTokens ?? null,
              ),
          },
        ),
        verdict: result.review.verdict,
        summary: result.review.summary,
      }),
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
  tone: ReviewTone,
  // A line above the verdict, e.g. that a smaller model wrote the review.
  notice: string | null = null,
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
      body:
        notice === null
          ? buildReviewSummaryBody(review, findings, unanchored, tone)
          : `${notice}\n\n${buildReviewSummaryBody(review, findings, unanchored, tone)}`,
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
        // The per-review comments endpoint returns `line: null`, so only
        // compare lines when GitHub supplies one.
        const match = anchored.find(
          ({ finding, line }) =>
            finding.filePath === comment.path &&
            (comment.line === null || line === comment.line) &&
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

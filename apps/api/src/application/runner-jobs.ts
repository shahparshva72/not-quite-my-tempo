import { Clock, Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  GitHubRepositoryRepository,
  ReviewRunRepository,
  RunnerJobRepository,
} from "@not-quite-my-tempo/db";
import type { RepositoryReviewRunner, RunnerJob } from "@not-quite-my-tempo/db";
import {
  buildReviewUserPrompt,
  buildRunnerSystemPrompt,
  DEFAULT_MODELS,
  filterReviewBySeverity,
  GeminiReview,
  reviewJsonSchema,
} from "@not-quite-my-tempo/reviewer";
import type { ReviewResult } from "@not-quite-my-tempo/reviewer";

import type { ActionsOidcClaims } from "../github/actions-oidc.js";
import { ReviewRequest } from "../github/review-request.js";
import { fetchRepositoryContext } from "./repository-context.js";
import {
  fetchReviewablePullRequest,
  loadPriorReview,
  requireReviewRun,
  reviewToneOf,
} from "./review-workflow.js";
import type { ReviewablePullRequest } from "./review-workflow.js";

/**
 * Reviews that run in the repository's own GitHub Actions, on the owner's
 * Claude subscription. The review Workflow issues a job and waits for
 * {@link RUNNER_RESULT_EVENT}. The repository's `fletcher-review.yml`
 * claims the job, getting the review prompt; runs Claude Code on its own
 * `CLAUDE_CODE_OAUTH_TOKEN` secret, which Fletcher never sees; and reports
 * the result, which resumes the Workflow. Both calls authenticate with the
 * job's GitHub Actions OIDC token.
 */

export const RUNNER_RESULT_EVENT = "runner-result";

/** How long the Workflow waits for a runner before failing the run. */
export const RUNNER_WAIT_TIMEOUT = "30 minutes";

// A little longer than the wait, so a result that lands just in time can
// still be reported.
const JOB_LIFETIME_MILLIS = 35 * 60 * 1000;

/** The only workflow file that may claim jobs. */
export const RUNNER_WORKFLOW_FILE = "fletcher-review.yml";

/** The OIDC audience runners request unless RUNNER_OIDC_AUDIENCE is set. */
export const RUNNER_OIDC_AUDIENCE = "fletcher";

/** Claude Code's turn cap on the runner. */
export const RUNNER_MAX_TURNS = 20;

// What is stored on the run when a runner review doesn't produce one.
export const RunnerFailureCode = Schema.Literal(
  "runner_failed",
  "runner_cancelled",
  "runner_output_invalid",
);

export type RunnerFailureCode = typeof RunnerFailureCode.Type;

const RunnerUsage = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  totalTokens: Schema.NullOr(Schema.Number),
});

/** The event that resumes the Workflow (it re-decodes it). */
export const RunnerResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed"),
    review: GeminiReview,
    model: Schema.String,
    usage: RunnerUsage,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    code: RunnerFailureCode,
    message: Schema.String,
  }),
);

export type RunnerResult = typeof RunnerResult.Type;

/** The body of POST /runner/v1/claim. */
export const RunnerClaimRequest = Schema.Struct({
  pullRequestNumber: Schema.Number.pipe(Schema.int(), Schema.positive()),
  headSha: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/)),
});

export type RunnerClaimRequest = typeof RunnerClaimRequest.Type;

const ReportedTokens = Schema.optionalWith(
  Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  { default: () => null },
);

/** The body of POST /runner/v1/jobs/:id/result. */
export const RunnerReport = Schema.Struct({
  outcome: Schema.Literal("success", "failure", "cancelled"),
  // Claude Code's structured_output; decoded here, not trusted.
  structuredOutput: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.String.pipe(Schema.maxLength(100))),
  inputTokens: ReportedTokens,
  outputTokens: ReportedTokens,
  // Why the run failed, as the runner saw it. Shown on the dashboard.
  message: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
});

export type RunnerReport = typeof RunnerReport.Type;

/** The OIDC token's claims don't fit a runner for this job. */
export class RunnerClaimsRejectedError extends Data.TaggedError(
  "RunnerClaimsRejectedError",
)<{
  readonly reason: string;
}> {}

/** No job for that commit yet: the Workflow may not have issued it. */
export class RunnerJobNotReadyError extends Data.TaggedError(
  "RunnerJobNotReadyError",
) {}

/** The job doesn't exist, or isn't this repository's. */
export class RunnerJobNotFoundError extends Data.TaggedError(
  "RunnerJobNotFoundError",
) {}

/** Another run claimed the job, or it already finished or expired. */
export class RunnerJobUnavailableError extends Data.TaggedError(
  "RunnerJobUnavailableError",
) {}

export class RunnerResultDeliveryError extends Data.TaggedError(
  "RunnerResultDeliveryError",
)<{
  readonly cause: unknown;
}> {}

export interface RunnerResultSinkService {
  /** Resumes the review Workflow instance waiting on this result. */
  readonly deliver: (
    workflowInstanceId: string,
    result: RunnerResult,
  ) => Effect.Effect<void, RunnerResultDeliveryError>;
}

export class RunnerResultSink extends Context.Tag(
  "@not-quite-my-tempo/api/RunnerResultSink",
)<RunnerResultSink, RunnerResultSinkService>() {}

export const RunnerResultSinkLive = (workflow: Workflow) =>
  Layer.succeed(
    RunnerResultSink,
    RunnerResultSink.of({
      deliver: (workflowInstanceId, result) =>
        Effect.tryPromise({
          try: async () => {
            const instance = await workflow.get(workflowInstanceId);

            await instance.sendEvent({
              type: RUNNER_RESULT_EVENT,
              payload: result,
            });
          },
          catch: (cause) => new RunnerResultDeliveryError({ cause }),
        }),
    }),
  );

const randomJobId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return `rj_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/** Where the run's repository reviews: in Fletcher or on its own runner. */
export const repositoryReviewRunner = (reviewRunId: number) =>
  Effect.gen(function* () {
    const run = yield* requireReviewRun(
      reviewRunId,
      ReviewRunRepository.findById(reviewRunId),
    );

    const repository = yield* GitHubRepositoryRepository.findById(
      run.repositoryId,
    );

    return Option.match(repository, {
      onNone: (): RepositoryReviewRunner => "fletcher",
      onSome: (found) => found.reviewRunner,
    });
  });

/** Issues the run's runner job; issuing again returns the same job. */
export const issueRunnerJob = (
  reviewRunId: number,
  workflowInstanceId: string,
  request: ReviewRequest,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const job = yield* RunnerJobRepository.issue({
      id: randomJobId(),
      reviewRunId,
      workflowInstanceId,
      githubRepositoryId: request.githubRepositoryId,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
      request: JSON.stringify(Schema.encodeSync(ReviewRequest)(request)),
      expiresAt: new Date(now + JOB_LIFETIME_MILLIS),
    });

    return { jobId: job.id };
  });

/** Marks the run's job expired once the Workflow stops waiting for it. */
export const expireRunnerJob = (reviewRunId: number) =>
  RunnerJobRepository.expire(reviewRunId);

const claimant = (claims: ActionsOidcClaims) => ({
  githubRunId: claims.run_id,
  githubRunAttempt: claims.run_attempt,
});

const parseGitHubId = (value: string) => {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0 ? Option.some(id) : Option.none();
};

// Only a pull_request run of the repository's own fletcher-review.yml may
// claim: pull_request_target or another workflow could be steered by code
// the repository's owner never merged.
const checkRunnerClaims = (
  claims: ActionsOidcClaims,
  pullRequestNumber: number,
) =>
  Effect.gen(function* () {
    const githubRepositoryId = yield* Option.match(
      parseGitHubId(claims.repository_id),
      {
        onNone: () =>
          Effect.fail(
            new RunnerClaimsRejectedError({ reason: "bad repository_id" }),
          ),
        onSome: Effect.succeed,
      },
    );

    if (claims.event_name !== "pull_request") {
      return yield* new RunnerClaimsRejectedError({
        reason: `event ${claims.event_name} can't claim reviews`,
      });
    }

    if (claims.ref !== `refs/pull/${pullRequestNumber}/merge`) {
      return yield* new RunnerClaimsRejectedError({
        reason: "the run isn't for that pull request",
      });
    }

    const workflowPrefix = `${claims.repository}/.github/workflows/${RUNNER_WORKFLOW_FILE}@`;

    if (!claims.job_workflow_ref.startsWith(workflowPrefix)) {
      return yield* new RunnerClaimsRejectedError({
        reason: `only .github/workflows/${RUNNER_WORKFLOW_FILE} can claim reviews`,
      });
    }

    return githubRepositoryId;
  });

/**
 * Claims the open job for this commit of the pull request on behalf of the
 * GitHub Actions run whose OIDC claims these are.
 */
export const claimRunnerJob = (
  claims: ActionsOidcClaims,
  body: RunnerClaimRequest,
) =>
  Effect.gen(function* () {
    const githubRepositoryId = yield* checkRunnerClaims(
      claims,
      body.pullRequestNumber,
    );

    const now = new Date(yield* Clock.currentTimeMillis);

    const open = yield* RunnerJobRepository.findOpen(
      githubRepositoryId,
      body.pullRequestNumber,
      body.headSha,
      now,
    );

    if (Option.isNone(open)) {
      return yield* new RunnerJobNotReadyError();
    }

    const claimed = yield* RunnerJobRepository.claim(
      open.value.id,
      claimant(claims),
      now,
    );

    if (Option.isNone(claimed)) {
      return yield* new RunnerJobUnavailableError();
    }

    const request = yield* Schema.decodeUnknown(
      Schema.parseJson(ReviewRequest),
    )(claimed.value.request).pipe(Effect.orDie);

    return { job: claimed.value, request };
  });

/** What the runner needs to review: the production prompt, split in two. */
export interface RunnerBundle {
  readonly jobId: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly schema: typeof reviewJsonSchema;
}

/**
 * Builds the review prompt for a claimed job, the way the Workflow builds
 * it for a model call: the repository's .fletcher.json (or the dashboard
 * tone), its filtered diff, its context, and the prior review.
 */
export const buildRunnerBundle = (
  installationToken: string,
  job: RunnerJob,
  request: ReviewRequest,
) =>
  Effect.gen(function* () {
    const run = yield* requireReviewRun(
      job.reviewRunId,
      ReviewRunRepository.findById(job.reviewRunId),
    );

    const repository = yield* GitHubRepositoryRepository.findById(
      run.repositoryId,
    );

    const toneOverride = Option.match(repository, {
      onNone: () => null,
      onSome: (found) => found.reviewTone,
    });

    const pullRequest: ReviewablePullRequest =
      yield* fetchReviewablePullRequest(
        installationToken,
        request,
        toneOverride,
      );

    const priorReview = yield* loadPriorReview(job.reviewRunId);

    const context = yield* fetchRepositoryContext({
      installationToken,
      ref: {
        owner: request.owner,
        repo: request.repo,
        pullRequestNumber: request.pullRequestNumber,
      },
      defaultBranch: request.defaultBranch,
      headSha: pullRequest.details.headSha,
      diff: pullRequest.diff,
      guidelines: pullRequest.config.guidelines ?? null,
    });

    const tone = reviewToneOf(pullRequest.config);

    const bundle: RunnerBundle = {
      jobId: job.id,
      model: DEFAULT_MODELS.anthropic,
      maxTurns: RUNNER_MAX_TURNS,
      systemPrompt: buildRunnerSystemPrompt(pullRequest.config.intensity, tone),
      prompt: buildReviewUserPrompt({
        repository: `${request.owner}/${request.repo}`,
        pullRequestNumber: request.pullRequestNumber,
        title: pullRequest.details.title,
        body: pullRequest.details.body,
        diff: pullRequest.diff,
        priorReview,
        context,
        intensity: pullRequest.config.intensity,
        tone,
      }),
      schema: reviewJsonSchema,
    };

    return bundle;
  });

const failed = (code: RunnerFailureCode, message: string): RunnerResult => ({
  status: "failed",
  code,
  message,
});

/** What the runner's report means for the run. */
export const runnerResultOf = (report: RunnerReport): RunnerResult => {
  if (report.outcome === "cancelled") {
    return failed("runner_cancelled", "The GitHub Actions run was cancelled");
  }

  if (report.outcome === "failure") {
    return failed(
      "runner_failed",
      report.message ?? "Claude Code failed on the GitHub Actions runner",
    );
  }

  return Option.match(
    Schema.decodeUnknownOption(GeminiReview)(report.structuredOutput),
    {
      onNone: () =>
        failed(
          "runner_output_invalid",
          "Claude Code's output wasn't a valid review",
        ),
      onSome: (review): RunnerResult => ({
        status: "completed",
        review,
        model: report.model ?? DEFAULT_MODELS.anthropic,
        usage: {
          inputTokens: report.inputTokens,
          outputTokens: report.outputTokens,
          totalTokens:
            report.inputTokens === null || report.outputTokens === null
              ? null
              : report.inputTokens + report.outputTokens,
        },
      }),
    },
  );
};

/**
 * Takes a runner's report for a job it claimed, resumes the Workflow with
 * the result, then completes the job. The Workflow is resumed first so a
 * failed delivery leaves the job open for the runner to report again.
 */
export const reportRunnerJob = (
  claims: ActionsOidcClaims,
  jobId: string,
  report: RunnerReport,
) =>
  Effect.gen(function* () {
    const job = yield* RunnerJobRepository.findById(jobId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RunnerJobNotFoundError()),
          onSome: Effect.succeed,
        }),
      ),
    );

    // Someone else's job looks the same as no job.
    if (
      Option.getOrNull(parseGitHubId(claims.repository_id)) !==
      job.githubRepositoryId
    ) {
      return yield* new RunnerJobNotFoundError();
    }

    if (
      job.status !== "claimed" ||
      job.githubRunId !== claims.run_id ||
      job.githubRunAttempt !== claims.run_attempt
    ) {
      return yield* new RunnerJobUnavailableError();
    }

    const result = runnerResultOf(report);
    const sink = yield* RunnerResultSink;

    yield* sink.deliver(job.workflowInstanceId, result);

    const now = new Date(yield* Clock.currentTimeMillis);

    yield* RunnerJobRepository.complete(job.id, claimant(claims), now);

    return { status: result.status };
  });

/**
 * The review a runner produced, as the Workflow persists and posts it.
 * The model call ran on the user's subscription, so nothing is billed.
 */
export const runnerReviewResult = (
  result: Extract<RunnerResult, { readonly status: "completed" }>,
  pullRequest: ReviewablePullRequest,
): Omit<ReviewResult, "provider"> => ({
  review: filterReviewBySeverity(
    result.review,
    pullRequest.config.severityThreshold,
  ),
  model: result.model,
  usage: result.usage,
});

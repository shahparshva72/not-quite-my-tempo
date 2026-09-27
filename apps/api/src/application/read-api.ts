import { Data, Effect, Option } from "effect";
import {
  FindingRepository,
  GitHubRepositoryRepository,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import type {
  FindingSeverityCount,
  GitHubRepository,
  ReviewRun,
} from "@not-quite-my-tempo/db";

const RUNS_PAGE_SIZE = 25;

/**
 * Raised when a resource does not exist or the session's repositories do
 * not grant access to it. Both cases intentionally map to the same error so
 * resource IDs cannot be enumerated.
 */
export class ResourceNotFoundError extends Data.TaggedError(
  "ResourceNotFoundError",
) {}

export const listAccessibleRepositories = (repositoryIds: readonly number[]) =>
  GitHubRepositoryRepository.listByGithubRepositoryIds(repositoryIds);

export const requireAccessibleRepository = (
  repositoryIds: readonly number[],
  repositoryId: number,
) =>
  GitHubRepositoryRepository.findById(repositoryId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => new ResourceNotFoundError(),
        onSome: (repository) =>
          repository.removedAt === null &&
          repositoryIds.includes(repository.githubRepositoryId)
            ? Effect.succeed(repository)
            : new ResourceNotFoundError(),
      }),
    ),
  );

export const listRepositoryRuns = (
  repositoryIds: readonly number[],
  repositoryId: number,
) =>
  Effect.gen(function* () {
    const repository = yield* requireAccessibleRepository(
      repositoryIds,
      repositoryId,
    );

    const runs = yield* ReviewRunRepository.listByRepository(
      repository.id,
      RUNS_PAGE_SIZE,
    );

    return { repository, runs };
  });

export const listRunFindings = (
  repositoryIds: readonly number[],
  reviewRunId: number,
) =>
  Effect.gen(function* () {
    const run = yield* ReviewRunRepository.findById(reviewRunId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new ResourceNotFoundError(),
          onSome: Effect.succeed,
        }),
      ),
    );

    yield* requireAccessibleRepository(repositoryIds, run.repositoryId);

    const findings = yield* FindingRepository.listByReviewRun(run.id);

    return { run, findings };
  });

export const usageSummary = (repositoryIds: readonly number[]) =>
  Effect.gen(function* () {
    const repositories = yield* listAccessibleRepositories(repositoryIds);

    const usage = yield* ReviewRunRepository.usageByRepositoryIds(
      repositories.map((repository) => repository.id),
    );

    return repositories.map((repository) => {
      const summary = usage.find(
        (entry) => entry.repositoryId === repository.id,
      );

      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        runCount: summary?.runCount ?? 0,
        inputTokens: summary?.inputTokens ?? 0,
        outputTokens: summary?.outputTokens ?? 0,
        totalTokens: summary?.totalTokens ?? 0,
      };
    });
  });

export interface SeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly suggestion: number;
}

/** A review run with how many findings of each severity it produced. */
export interface ReviewSummary {
  readonly run: ReviewRun;
  readonly counts: SeverityCounts;
}

const summarize = (
  runs: readonly ReviewRun[],
  counts: readonly FindingSeverityCount[],
): readonly ReviewSummary[] =>
  runs.map((run) => {
    const countOf = (severity: FindingSeverityCount["severity"]) =>
      counts.find(
        (entry) => entry.reviewRunId === run.id && entry.severity === severity,
      )?.findingCount ?? 0;

    return {
      run,
      counts: {
        critical: countOf("critical"),
        warning: countOf("warning"),
        suggestion: countOf("suggestion"),
      },
    };
  });

const summarizeRuns = (runs: readonly ReviewRun[]) =>
  FindingRepository.severityCountsByReviewRunIds(
    runs.map((run) => run.id),
  ).pipe(Effect.map((counts) => summarize(runs, counts)));

export interface RepositoryOverview {
  readonly repository: GitHubRepository;
  readonly latest: ReviewSummary | null;
}

/**
 * Dashboard data: each accessible repository with its most recent review,
 * plus all-time totals across them.
 */
export const dashboardOverview = (repositoryIds: readonly number[]) =>
  Effect.gen(function* () {
    const repositories = yield* listAccessibleRepositories(repositoryIds);
    const ids = repositories.map((repository) => repository.id);

    const latestRuns = yield* ReviewRunRepository.latestByRepositoryIds(ids);
    const latest = yield* summarizeRuns(latestRuns);
    const usage = yield* ReviewRunRepository.usageByRepositoryIds(ids);

    const overview: readonly RepositoryOverview[] = repositories.map(
      (repository) => ({
        repository,
        latest:
          latest.find(
            (summary) => summary.run.repositoryId === repository.id,
          ) ?? null,
      }),
    );

    return {
      repositories: overview,
      totals: {
        reviewCount: usage.reduce((sum, entry) => sum + entry.runCount, 0),
        totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
      },
    };
  });

/** Repository page data: its recent reviews with finding counts. */
export const repositoryReviewHistory = (
  repositoryIds: readonly number[],
  repositoryId: number,
) =>
  listRepositoryRuns(repositoryIds, repositoryId).pipe(
    Effect.flatMap(({ repository, runs }) =>
      summarizeRuns(runs).pipe(
        Effect.map((reviews) => ({ repository, reviews })),
      ),
    ),
  );

const severityOrder = { critical: 0, warning: 1, suggestion: 2 } as const;

/**
 * Review page data: the run, its repository (for GitHub links), and its
 * findings loudest first, then by file and line.
 */
export const reviewDetail = (
  repositoryIds: readonly number[],
  reviewRunId: number,
) =>
  Effect.gen(function* () {
    const { run, findings } = yield* listRunFindings(
      repositoryIds,
      reviewRunId,
    );

    const repository = yield* requireAccessibleRepository(
      repositoryIds,
      run.repositoryId,
    );

    const ordered = [...findings].sort(
      (left, right) =>
        severityOrder[left.severity] - severityOrder[right.severity] ||
        left.filePath.localeCompare(right.filePath) ||
        (left.line ?? 0) - (right.line ?? 0),
    );

    return { repository, run, findings: ordered };
  });

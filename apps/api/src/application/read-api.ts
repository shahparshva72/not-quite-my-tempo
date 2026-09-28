import { Effect, Option } from "effect";
import {
  FindingRepository,
  MembershipRepository,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import {
  authorizeRepository,
  ResourceNotFoundError,
  visibleRepositories,
} from "./authorization.js";
import type { SessionAccess } from "./authorization.js";
import type {
  FindingSeverityCount,
  GitHubRepository,
  ReviewRun,
  Workspace,
  WorkspaceRole,
} from "@not-quite-my-tempo/db";

const RUNS_PAGE_SIZE = 25;

export const listAccessibleRepositories = (access: SessionAccess) =>
  visibleRepositories(access).pipe(
    Effect.map((visible) => visible.map((entry) => entry.repository)),
  );

/** A repository the user may view, or ResourceNotFoundError. */
export const requireAccessibleRepository = (
  access: SessionAccess,
  repositoryId: number,
) =>
  authorizeRepository(access, repositoryId, "view").pipe(
    Effect.map((visible) => visible.repository),
    // Viewing needs only membership, so ForbiddenError can't occur; keep
    // the 404-only contract for readers.
    Effect.catchTag("ForbiddenError", () => new ResourceNotFoundError()),
  );

export const listRepositoryRuns = (
  access: SessionAccess,
  repositoryId: number,
) =>
  Effect.gen(function* () {
    const repository = yield* requireAccessibleRepository(access, repositoryId);

    const runs = yield* ReviewRunRepository.listByRepository(
      repository.id,
      RUNS_PAGE_SIZE,
    );

    return { repository, runs };
  });

export const listRunFindings = (access: SessionAccess, reviewRunId: number) =>
  Effect.gen(function* () {
    const run = yield* ReviewRunRepository.findById(reviewRunId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new ResourceNotFoundError(),
          onSome: Effect.succeed,
        }),
      ),
    );

    yield* requireAccessibleRepository(access, run.repositoryId);

    const findings = yield* FindingRepository.listByReviewRun(run.id);

    return { run, findings };
  });

export const usageSummary = (access: SessionAccess) =>
  Effect.gen(function* () {
    const repositories = yield* listAccessibleRepositories(access);

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

export interface WorkspaceOverview {
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
  readonly repositories: readonly RepositoryOverview[];
}

/**
 * Dashboard data: each workspace the user belongs to, with the repositories
 * they can see in it and each one's most recent review, plus all-time
 * totals across them.
 */
export const dashboardOverview = (access: SessionAccess) =>
  Effect.gen(function* () {
    const memberships = yield* MembershipRepository.listForUser(access.userId);
    const visible = yield* visibleRepositories(access);
    const ids = visible.map((entry) => entry.repository.id);

    const latestRuns = yield* ReviewRunRepository.latestByRepositoryIds(ids);
    const latest = yield* summarizeRuns(latestRuns);
    const usage = yield* ReviewRunRepository.usageByRepositoryIds(ids);

    const workspaces: readonly WorkspaceOverview[] = memberships.map(
      (membership) => ({
        workspace: membership.workspace,
        role: membership.role,
        repositories: visible
          .filter((entry) => entry.workspaceId === membership.workspace.id)
          .map(({ repository }) => ({
            repository,
            latest:
              latest.find(
                (summary) => summary.run.repositoryId === repository.id,
              ) ?? null,
          })),
      }),
    );

    return {
      workspaces,
      totals: {
        reviewCount: usage.reduce((sum, entry) => sum + entry.runCount, 0),
        totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
      },
    };
  });

/** Repository page data: its recent reviews with finding counts. */
export const repositoryReviewHistory = (
  access: SessionAccess,
  repositoryId: number,
) =>
  Effect.gen(function* () {
    const visible = yield* authorizeRepository(access, repositoryId, "view");

    const runs = yield* ReviewRunRepository.listByRepository(
      visible.repository.id,
      RUNS_PAGE_SIZE,
    );

    const reviews = yield* summarizeRuns(runs);

    return { repository: visible.repository, role: visible.role, reviews };
  });

const severityOrder = { critical: 0, warning: 1, suggestion: 2 } as const;

/**
 * Review page data: the run, its repository (for GitHub links), and its
 * findings loudest first, then by file and line.
 */
export const reviewDetail = (access: SessionAccess, reviewRunId: number) =>
  Effect.gen(function* () {
    const { run, findings } = yield* listRunFindings(access, reviewRunId);

    const repository = yield* requireAccessibleRepository(
      access,
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

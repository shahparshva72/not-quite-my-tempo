import { Data, Effect, Option } from "effect";
import {
  FindingRepository,
  GitHubRepositoryRepository,
  ReviewRunRepository,
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

import { env } from "cloudflare:workers";
import { Effect, Either } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DatabaseError,
  makeLiveLayer,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";

import { resetAndSeedRepository } from "./database";

const run = <A, E>(effect: Effect.Effect<A, E, ReviewRunRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeLiveLayer(env.DB))));

const input = {
  repositoryId: 1,
  pullRequestNumber: 42,
  headSha: "abc123",
  trigger: "opened" as const,
  model: "test-model",
};

describe("ReviewRunRepository", () => {
  beforeEach(resetAndSeedRepository);

  it("creates and finds a review run", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repository = yield* ReviewRunRepository;
        const created = yield* repository.create(input);

        const byId = yield* repository
          .findById(created.id)
          .pipe(Effect.flatten);

        const byCommit = yield* repository
          .findByPullRequestCommit(1, 42, "abc123")
          .pipe(Effect.flatten);

        return { created, byId, byCommit };
      }),
    );

    expect(result.created).toMatchObject({ ...input, status: "queued" });
    expect(result.byId).toEqual(result.created);
    expect(result.byCommit).toEqual(result.created);
  });

  it("marks review runs as running, completed, or failed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repository = yield* ReviewRunRepository;
        const completedRun = yield* repository.create(input);

        const running = yield* repository
          .markRunning(completedRun.id)
          .pipe(Effect.flatten);

        const completed = yield* repository
          .markCompleted(completedRun.id)
          .pipe(Effect.flatten);

        const failedRun = yield* repository.create({
          ...input,
          headSha: "def456",
        });

        const failed = yield* repository
          .markFailed(failedRun.id, "model_error", "Model request failed")
          .pipe(Effect.flatten);

        return { running, completed, failed };
      }),
    );

    expect(result.running).toMatchObject({ status: "running" });
    expect(result.running.startedAt).toBeInstanceOf(Date);
    expect(result.completed).toMatchObject({ status: "completed" });
    expect(result.completed.completedAt).toBeInstanceOf(Date);
    expect(result.failed).toMatchObject({
      status: "failed",
      errorCode: "model_error",
      errorMessage: "Model request failed",
    });
  });

  it("returns typed database errors", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repository = yield* ReviewRunRepository;
        yield* repository.create(input);

        return yield* repository.create(input).pipe(Effect.either);
      }),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DatabaseError);
      expect(result.left.operation).toBe("review_runs.create");
    }
  });

  it("returns the existing review run for the same pull request commit", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repository = yield* ReviewRunRepository;
        const first = yield* repository.createOrFind(input);
        const duplicate = yield* repository.createOrFind(input);

        return { first, duplicate };
      }),
    );

    expect(result.first._tag).toBe("Created");
    expect(result.duplicate._tag).toBe("Existing");
    expect(result.duplicate.reviewRun.id).toBe(result.first.reviewRun.id);
  });
});

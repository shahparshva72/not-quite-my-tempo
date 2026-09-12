import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { DatabaseError } from "../errors.js";
import { reviewRuns } from "../schema/review-runs.js";
import { Database } from "../services/database.js";

export type ReviewRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ReviewRunTrigger = "opened" | "synchronize" | "reopened" | "manual";

export interface ReviewRun {
  readonly id: number;
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly status: ReviewRunStatus;
  readonly trigger: ReviewRunTrigger;
  readonly model: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateReviewRunInput {
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly trigger: ReviewRunTrigger;
  readonly model?: string | null;
}

export interface ReviewRunRepositoryService {
  readonly create: (
    input: CreateReviewRunInput,
  ) => Effect.Effect<ReviewRun, DatabaseError>;
  readonly findById: (
    id: number,
  ) => Effect.Effect<ReviewRun | undefined, DatabaseError>;
  readonly findByPullRequestCommit: (
    repositoryId: number,
    pullRequestNumber: number,
    headSha: string,
  ) => Effect.Effect<ReviewRun | undefined, DatabaseError>;
  readonly markRunning: (
    id: number,
  ) => Effect.Effect<ReviewRun | undefined, DatabaseError>;
  readonly markCompleted: (
    id: number,
  ) => Effect.Effect<ReviewRun | undefined, DatabaseError>;
  readonly markFailed: (
    id: number,
    errorCode: string,
    errorMessage: string,
  ) => Effect.Effect<ReviewRun | undefined, DatabaseError>;
}

export class ReviewRunRepository extends Context.Tag(
  "@not-quite-my-tempo/db/ReviewRunRepository",
)<ReviewRunRepository, ReviewRunRepositoryService>() {}

const databaseEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DatabaseError({ operation, cause }),
  });

export const ReviewRunRepositoryLive = Layer.effect(
  ReviewRunRepository,
  Effect.gen(function* () {
    const { client } = yield* Database;

    return ReviewRunRepository.of({
      create: (input) =>
        databaseEffect("review_runs.create", () =>
          client
            .insert(reviewRuns)
            .values({
              repositoryId: input.repositoryId,
              pullRequestNumber: input.pullRequestNumber,
              headSha: input.headSha,
              status: "queued",
              trigger: input.trigger,
              model: input.model ?? null,
            })
            .returning()
            .get(),
        ),
      findById: (id) =>
        databaseEffect("review_runs.find_by_id", () =>
          client.select().from(reviewRuns).where(eq(reviewRuns.id, id)).get(),
        ),
      findByPullRequestCommit: (repositoryId, pullRequestNumber, headSha) =>
        databaseEffect("review_runs.find_by_pull_request_commit", () =>
          client
            .select()
            .from(reviewRuns)
            .where(
              and(
                eq(reviewRuns.repositoryId, repositoryId),
                eq(reviewRuns.pullRequestNumber, pullRequestNumber),
                eq(reviewRuns.headSha, headSha),
              ),
            )
            .get(),
        ),
      markRunning: (id) =>
        databaseEffect("review_runs.mark_running", () =>
          client
            .update(reviewRuns)
            .set({ status: "running", startedAt: new Date() })
            .where(eq(reviewRuns.id, id))
            .returning()
            .get(),
        ),
      markCompleted: (id) =>
        databaseEffect("review_runs.mark_completed", () =>
          client
            .update(reviewRuns)
            .set({ status: "completed", completedAt: new Date() })
            .where(eq(reviewRuns.id, id))
            .returning()
            .get(),
        ),
      markFailed: (id, errorCode, errorMessage) =>
        databaseEffect("review_runs.mark_failed", () =>
          client
            .update(reviewRuns)
            .set({
              status: "failed",
              completedAt: new Date(),
              errorCode,
              errorMessage,
            })
            .where(eq(reviewRuns.id, id))
            .returning()
            .get(),
        ),
    });
  }),
);

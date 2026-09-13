import { and, count, eq, gte } from "drizzle-orm";
import { Array, Data, Effect, Option } from "effect";

import { databaseEffect, DatabaseError } from "../errors.js";
import {
  reviewRuns,
  reviewRunStatuses,
  reviewRunTriggers,
} from "../schema/review-runs.js";
import { repositories } from "../schema/repositories.js";
import { Database } from "../services/database.js";

export type ReviewRun = typeof reviewRuns.$inferSelect;

export interface ReviewRunUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export type ReviewRunStatus = (typeof reviewRunStatuses)[number];

export type ReviewRunTrigger = (typeof reviewRunTriggers)[number];

export interface CreateReviewRunInput {
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly trigger: ReviewRunTrigger;
  readonly model?: string | null;
}

export type CreateReviewRunResult = Data.TaggedEnum<{
  Created: { readonly reviewRun: ReviewRun };
  Existing: { readonly reviewRun: ReviewRun };
}>;

export const ReviewRunCreation = Data.taggedEnum<CreateReviewRunResult>();

const insertValues = (input: CreateReviewRunInput) => ({
  repositoryId: input.repositoryId,
  pullRequestNumber: input.pullRequestNumber,
  headSha: input.headSha,
  status: "queued" as const,
  trigger: input.trigger,
  model: input.model ?? null,
});

export class ReviewRunRepository extends Effect.Service<ReviewRunRepository>()(
  "@not-quite-my-tempo/db/ReviewRunRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      const findByPullRequestCommit = (
        repositoryId: number,
        pullRequestNumber: number,
        headSha: string,
      ) =>
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
        ).pipe(Effect.map(Option.fromNullable));

      return {
        create: (input: CreateReviewRunInput) =>
          databaseEffect("review_runs.create", () =>
            client
              .insert(reviewRuns)
              .values(insertValues(input))
              .returning()
              .get(),
          ),
        createOrFind: (input: CreateReviewRunInput) =>
          databaseEffect("review_runs.create_or_find", () =>
            client
              .insert(reviewRuns)
              .values(insertValues(input))
              .onConflictDoNothing({
                target: [
                  reviewRuns.repositoryId,
                  reviewRuns.pullRequestNumber,
                  reviewRuns.headSha,
                ],
              })
              .returning()
              .all(),
          ).pipe(
            Effect.map(Array.head),
            Effect.flatMap(
              (inserted): Effect.Effect<CreateReviewRunResult, DatabaseError> =>
                Option.match(inserted, {
                  onSome: (reviewRun) =>
                    Effect.succeed(ReviewRunCreation.Created({ reviewRun })),
                  onNone: () =>
                    findByPullRequestCommit(
                      input.repositoryId,
                      input.pullRequestNumber,
                      input.headSha,
                    ).pipe(
                      Effect.flatten,
                      Effect.catchTag(
                        "NoSuchElementException",
                        (cause) =>
                          new DatabaseError({
                            operation: "review_runs.find_after_conflict",
                            cause,
                          }),
                      ),
                      Effect.map((reviewRun) =>
                        ReviewRunCreation.Existing({ reviewRun }),
                      ),
                    ),
                }),
            ),
          ),
        findById: (id: number) =>
          databaseEffect("review_runs.find_by_id", () =>
            client.select().from(reviewRuns).where(eq(reviewRuns.id, id)).get(),
          ).pipe(Effect.map(Option.fromNullable)),
        findByPullRequestCommit,
        markRunning: (id: number) =>
          databaseEffect("review_runs.mark_running", () =>
            client
              .update(reviewRuns)
              .set({ status: "running", startedAt: new Date() })
              .where(eq(reviewRuns.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        recordModelUsage: (id: number, model: string, usage: ReviewRunUsage) =>
          databaseEffect("review_runs.record_model_usage", () =>
            client
              .update(reviewRuns)
              .set({
                model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              })
              .where(eq(reviewRuns.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        countForInstallationSince: (installationId: number, since: Date) =>
          databaseEffect("review_runs.count_for_installation_since", () =>
            client
              .select({ total: count() })
              .from(reviewRuns)
              .innerJoin(
                repositories,
                eq(reviewRuns.repositoryId, repositories.id),
              )
              .where(
                and(
                  eq(repositories.installationId, installationId),
                  gte(reviewRuns.createdAt, since),
                ),
              )
              .get(),
          ).pipe(Effect.map((row) => row?.total ?? 0)),
        markCompleted: (id: number) =>
          databaseEffect("review_runs.mark_completed", () =>
            client
              .update(reviewRuns)
              .set({
                status: "completed",
                completedAt: new Date(),
                errorCode: null,
                errorMessage: null,
              })
              .where(eq(reviewRuns.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        markFailed: (id: number, errorCode: string, errorMessage: string) =>
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
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

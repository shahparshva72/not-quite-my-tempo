import { and, count, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { Array, Data, Effect, Option } from "effect";

import { databaseEffect, DatabaseError } from "../errors.js";
import {
  reviewKeySources,
  reviewRuns,
  reviewRunStatuses,
  reviewRunTriggers,
  reviewVerdicts,
} from "../schema/review-runs.js";
import { findings } from "../schema/findings.js";
import { repositories } from "../schema/repositories.js";
import { Database } from "../services/database.js";

export type ReviewRun = typeof reviewRuns.$inferSelect;

export interface ReviewRunUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface RepositoryUsageSummary {
  readonly repositoryId: number;
  readonly runCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type ReviewKeySource = (typeof reviewKeySources)[number];

export type ReviewRunVerdict = (typeof reviewVerdicts)[number];

export interface ReviewRunResult {
  readonly model: string;
  readonly usage: ReviewRunUsage;
  readonly verdict: ReviewRunVerdict;
  readonly summary: string;
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
        findLatestCompletedForPullRequest: (
          repositoryId: number,
          pullRequestNumber: number,
          excludeReviewRunId: number,
        ) =>
          databaseEffect(
            "review_runs.find_latest_completed_for_pull_request",
            () =>
              client
                .select()
                .from(reviewRuns)
                .where(
                  and(
                    eq(reviewRuns.repositoryId, repositoryId),
                    eq(reviewRuns.pullRequestNumber, pullRequestNumber),
                    eq(reviewRuns.status, "completed"),
                    ne(reviewRuns.id, excludeReviewRunId),
                  ),
                )
                .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id))
                .limit(1)
                .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        markRunning: (id: number) =>
          databaseEffect("review_runs.mark_running", () =>
            client
              .update(reviewRuns)
              .set({ status: "running", startedAt: new Date() })
              .where(eq(reviewRuns.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        recordReviewResult: (id: number, result: ReviewRunResult) =>
          databaseEffect("review_runs.record_review_result", () =>
            client
              .update(reviewRuns)
              .set({
                model: result.model,
                verdict: result.verdict,
                summary: result.summary,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
              })
              .where(eq(reviewRuns.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        setKeySource: (id: number, keySource: ReviewKeySource) =>
          databaseEffect("review_runs.set_key_source", () =>
            client
              .update(reviewRuns)
              .set({ keySource })
              .where(eq(reviewRuns.id, id))
              .run(),
          ).pipe(Effect.asVoid),
        /**
         * Whether another run of this pull request was already blocked for
         * a missing Gemini key, so the explanation is posted only once.
         */
        hasEarlierBlockedRun: (
          repositoryId: number,
          pullRequestNumber: number,
          excludeRunId: number,
        ) =>
          databaseEffect("review_runs.has_earlier_blocked_run", () =>
            client
              .select({ id: reviewRuns.id })
              .from(reviewRuns)
              .where(
                and(
                  eq(reviewRuns.repositoryId, repositoryId),
                  eq(reviewRuns.pullRequestNumber, pullRequestNumber),
                  eq(reviewRuns.errorCode, "no_gemini_key"),
                  ne(reviewRuns.id, excludeRunId),
                ),
              )
              .get(),
          ).pipe(Effect.map((row) => row !== undefined)),
        listByRepository: (repositoryId: number, limit: number) =>
          databaseEffect("review_runs.list_by_repository", () =>
            client
              .select()
              .from(reviewRuns)
              .where(eq(reviewRuns.repositoryId, repositoryId))
              .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id))
              .limit(limit)
              .all(),
          ),
        /** The most recent run of each listed repository that has one. */
        latestByRepositoryIds: (repositoryIds: readonly number[]) =>
          repositoryIds.length === 0
            ? Effect.succeed<readonly ReviewRun[]>([])
            : databaseEffect("review_runs.latest_by_repository_ids", () =>
                client
                  .select()
                  .from(reviewRuns)
                  .where(
                    sql`${reviewRuns.id} in (select max(id) from review_runs where repository_id in (select value from json_each(${JSON.stringify(repositoryIds)})) group by repository_id)`,
                  )
                  .all(),
              ),
        usageByRepositoryIds: (repositoryIds: readonly number[]) =>
          repositoryIds.length === 0
            ? Effect.succeed<readonly RepositoryUsageSummary[]>([])
            : databaseEffect("review_runs.usage_by_repository_ids", () =>
                client
                  .select({
                    repositoryId: reviewRuns.repositoryId,
                    runCount: count(),
                    inputTokens: sql<number>`coalesce(sum(${reviewRuns.inputTokens}), 0)`,
                    outputTokens: sql<number>`coalesce(sum(${reviewRuns.outputTokens}), 0)`,
                    totalTokens: sql<number>`coalesce(sum(${reviewRuns.totalTokens}), 0)`,
                  })
                  .from(reviewRuns)
                  .where(
                    sql`${reviewRuns.repositoryId} in (select value from json_each(${JSON.stringify(repositoryIds)}))`,
                  )
                  .groupBy(reviewRuns.repositoryId)
                  .all(),
              ),
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
        /**
         * Re-queues a failed run for "/fletcher again" on the same commit:
         * only while it is still failed (so concurrent retries start one),
         * bumping `attempt` and clearing the failed attempt's results and
         * findings, in one batch. Returns the re-queued run, or None when
         * it wasn't failed.
         */
        requeueFailed: (id: number) =>
          databaseEffect("review_runs.requeue_failed", () =>
            client.batch([
              client
                .update(reviewRuns)
                .set({
                  status: "queued",
                  trigger: "manual",
                  attempt: sql`${reviewRuns.attempt} + 1`,
                  keySource: null,
                  model: null,
                  verdict: null,
                  summary: null,
                  errorCode: null,
                  errorMessage: null,
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                  startedAt: null,
                  completedAt: null,
                })
                .where(
                  and(eq(reviewRuns.id, id), eq(reviewRuns.status, "failed")),
                )
                .returning(),
              // Deletes only after the update above re-queued the run (now
              // queued and not started); any other run keeps its findings.
              client
                .delete(findings)
                .where(
                  and(
                    eq(findings.reviewRunId, id),
                    sql`exists (select 1 from ${reviewRuns} where ${reviewRuns.id} = ${id} and ${reviewRuns.status} = 'queued' and ${reviewRuns.startedAt} is null)`,
                  ),
                ),
            ]),
          ).pipe(Effect.map(([rows]) => Array.head(rows))),
        /** Runs still queued or running that haven't changed since `before`. */
        listStuck: (before: Date, limit: number) =>
          databaseEffect("review_runs.list_stuck", () =>
            client
              .select()
              .from(reviewRuns)
              .where(
                and(
                  inArray(reviewRuns.status, ["queued", "running"]),
                  lt(reviewRuns.updatedAt, before),
                ),
              )
              .orderBy(reviewRuns.id)
              .limit(limit)
              .all(),
          ),
        /**
         * Fails a run only if it is still queued or running and unchanged
         * since `before`, so recovery can't overwrite a review that finished
         * in the meantime. Returns whether it changed the run.
         */
        markStuckFailed: (id: number, before: Date, errorMessage: string) =>
          databaseEffect("review_runs.mark_stuck_failed", () =>
            client
              .update(reviewRuns)
              .set({
                status: "failed",
                completedAt: new Date(),
                errorCode: "stuck",
                errorMessage,
              })
              .where(
                and(
                  eq(reviewRuns.id, id),
                  inArray(reviewRuns.status, ["queued", "running"]),
                  lt(reviewRuns.updatedAt, before),
                ),
              )
              .returning({ id: reviewRuns.id })
              .get(),
          ).pipe(Effect.map((row) => row !== undefined)),
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

import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { runnerJobs, runnerJobStatuses } from "../schema/runner-jobs.js";
import { Database } from "../services/database.js";

export type RunnerJob = typeof runnerJobs.$inferSelect;

export type RunnerJobStatus = (typeof runnerJobStatuses)[number];

export type IssueRunnerJobInput = Pick<
  RunnerJob,
  | "id"
  | "reviewRunId"
  | "workflowInstanceId"
  | "githubRepositoryId"
  | "pullRequestNumber"
  | "headSha"
  | "request"
  | "expiresAt"
>;

/** The GitHub Actions run (and attempt) a job belongs to once claimed. */
export interface RunnerJobClaimant {
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
}

export class RunnerJobRepository extends Effect.Service<RunnerJobRepository>()(
  "@not-quite-my-tempo/db/RunnerJobRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      const findByReviewRun = (reviewRunId: number) =>
        databaseEffect("runner_jobs.find_by_review_run", () =>
          client
            .select()
            .from(runnerJobs)
            .where(eq(runnerJobs.reviewRunId, reviewRunId))
            .get(),
        ).pipe(Effect.map(Option.fromNullable));

      const sameClaimant = (claimant: RunnerJobClaimant) =>
        and(
          eq(runnerJobs.githubRunId, claimant.githubRunId),
          eq(runnerJobs.githubRunAttempt, claimant.githubRunAttempt),
        );

      return {
        /**
         * Issues the run's job. A run has at most one, so issuing again
         * (a retried Workflow step) returns the job already issued.
         */
        issue: (input: IssueRunnerJobInput) =>
          databaseEffect("runner_jobs.issue", () =>
            client
              .insert(runnerJobs)
              .values({ ...input, status: "issued" })
              .onConflictDoNothing({ target: runnerJobs.reviewRunId })
              .run(),
          ).pipe(
            Effect.zipRight(findByReviewRun(input.reviewRunId)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.dieMessage(
                    `runner job for review run ${input.reviewRunId} vanished after issue`,
                  ),
                onSome: Effect.succeed,
              }),
            ),
          ),
        findById: (id: string) =>
          databaseEffect("runner_jobs.find_by_id", () =>
            client.select().from(runnerJobs).where(eq(runnerJobs.id, id)).get(),
          ).pipe(Effect.map(Option.fromNullable)),
        findByReviewRun,
        /** The newest unexpired, unfinished job for this commit of a pull request. */
        findOpen: (
          githubRepositoryId: number,
          pullRequestNumber: number,
          headSha: string,
          now: Date,
        ) =>
          databaseEffect("runner_jobs.find_open", () =>
            client
              .select()
              .from(runnerJobs)
              .where(
                and(
                  eq(runnerJobs.githubRepositoryId, githubRepositoryId),
                  eq(runnerJobs.pullRequestNumber, pullRequestNumber),
                  eq(runnerJobs.headSha, headSha),
                  inArray(runnerJobs.status, ["issued", "claimed"]),
                  gt(runnerJobs.expiresAt, now),
                ),
              )
              .orderBy(desc(runnerJobs.createdAt))
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        /**
         * Claims an issued job for one GitHub Actions run. The same run
         * claiming again (a retried request) gets the job back; any other
         * run gets none.
         */
        claim: (id: string, claimant: RunnerJobClaimant, now: Date) =>
          databaseEffect("runner_jobs.claim", () =>
            client
              .update(runnerJobs)
              .set({ status: "claimed", ...claimant, claimedAt: now })
              .where(
                and(
                  eq(runnerJobs.id, id),
                  gt(runnerJobs.expiresAt, now),
                  or(
                    eq(runnerJobs.status, "issued"),
                    and(
                      eq(runnerJobs.status, "claimed"),
                      sameClaimant(claimant),
                    ),
                  ),
                ),
              )
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        /** Completes a job its claimant reports on; none if it can't. */
        complete: (id: string, claimant: RunnerJobClaimant, now: Date) =>
          databaseEffect("runner_jobs.complete", () =>
            client
              .update(runnerJobs)
              .set({ status: "completed", completedAt: now })
              .where(
                and(
                  eq(runnerJobs.id, id),
                  eq(runnerJobs.status, "claimed"),
                  sameClaimant(claimant),
                ),
              )
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
        /** Expires a run's job if it never finished. */
        expire: (reviewRunId: number) =>
          databaseEffect("runner_jobs.expire", () =>
            client
              .update(runnerJobs)
              .set({ status: "expired" })
              .where(
                and(
                  eq(runnerJobs.reviewRunId, reviewRunId),
                  inArray(runnerJobs.status, ["issued", "claimed"]),
                ),
              )
              .run(),
          ).pipe(Effect.asVoid),
      };
    }),
  },
) {}

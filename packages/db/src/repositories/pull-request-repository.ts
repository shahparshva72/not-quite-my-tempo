import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { databaseEffect } from "../errors.js";
import { pullRequests, pullRequestStates } from "../schema/pull-requests.js";
import { repositories } from "../schema/repositories.js";
import { reviewRuns } from "../schema/review-runs.js";
import { Database } from "../services/database.js";

export type PullRequest = typeof pullRequests.$inferSelect;

export type PullRequestState = (typeof pullRequestStates)[number];

/** A pull request's details as one GitHub webhook delivery reported them. */
export interface PullRequestSnapshot {
  readonly githubRepositoryId: number;
  readonly number: number;
  readonly title: string;
  readonly authorLogin: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly githubUpdatedAt: Date;
}

/** A review run's pull request, when its details are known. */
export interface ReviewRunPullRequest {
  readonly reviewRunId: number;
  readonly pullRequest: PullRequest;
}

export class PullRequestRepository extends Effect.Service<PullRequestRepository>()(
  "@not-quite-my-tempo/db/PullRequestRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        /**
         * Stores the snapshot for a repository Fletcher already knows,
         * unless a newer one is stored. Unknown repositories store nothing.
         * Returns whether a row was written.
         */
        record: (snapshot: PullRequestSnapshot) =>
          databaseEffect("pull_requests.record", () =>
            client.run(
              sql`insert into ${pullRequests} (
                  repository_id, number, title, author_login, head_ref,
                  base_ref, state, draft, github_updated_at
                )
                select ${repositories.id}, ${snapshot.number}, ${snapshot.title},
                  ${snapshot.authorLogin}, ${snapshot.headRef},
                  ${snapshot.baseRef}, ${snapshot.state},
                  ${snapshot.draft ? 1 : 0}, ${snapshot.githubUpdatedAt.getTime()}
                from ${repositories}
                where ${repositories.githubRepositoryId} = ${snapshot.githubRepositoryId}
                on conflict (repository_id, number) do update set
                  title = excluded.title,
                  author_login = excluded.author_login,
                  head_ref = excluded.head_ref,
                  base_ref = excluded.base_ref,
                  state = excluded.state,
                  draft = excluded.draft,
                  github_updated_at = excluded.github_updated_at,
                  updated_at = unixepoch() * 1000
                where excluded.github_updated_at >= ${pullRequests}.github_updated_at`,
            ),
          ).pipe(Effect.map((result) => result.meta.changes > 0)),
        /** The pull requests of these review runs, where known. */
        listForReviewRuns: (reviewRunIds: readonly number[]) =>
          reviewRunIds.length === 0
            ? Effect.succeed<readonly ReviewRunPullRequest[]>([])
            : databaseEffect("pull_requests.list_for_review_runs", () =>
                client
                  .select({
                    reviewRunId: reviewRuns.id,
                    pullRequest: pullRequests,
                  })
                  .from(reviewRuns)
                  .innerJoin(
                    pullRequests,
                    and(
                      eq(pullRequests.repositoryId, reviewRuns.repositoryId),
                      eq(pullRequests.number, reviewRuns.pullRequestNumber),
                    ),
                  )
                  .where(
                    sql`${reviewRuns.id} in (select value from json_each(${JSON.stringify(reviewRunIds)}))`,
                  )
                  .all(),
              ),
      };
    }),
  },
) {}

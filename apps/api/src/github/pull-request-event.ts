import { Effect, Option, Schema } from "effect";
import type { PullRequestSnapshot } from "@not-quite-my-tempo/db";

import { GitHubId } from "./review-request.js";

// Every pull_request action carries the pull request as it is now, so any
// of them (opened, edited, closed, ...) can refresh the stored details.
const PullRequestDetailsWebhook = Schema.Struct({
  number: GitHubId,
  pull_request: Schema.Struct({
    title: Schema.String,
    user: Schema.Struct({ login: Schema.NonEmptyString }),
    state: Schema.Literal("open", "closed"),
    merged_at: Schema.NullOr(Schema.String),
    draft: Schema.optional(Schema.Boolean),
    head: Schema.Struct({ ref: Schema.String }),
    base: Schema.Struct({ ref: Schema.String }),
    // Schema.Date rejects an unparsable date, which would store NaN.
    updated_at: Schema.Date,
  }),
  repository: Schema.Struct({ id: GitHubId }),
});

/**
 * Decodes a `pull_request` delivery into the pull request's current
 * details. Returns `None` when the payload lacks them: the details only
 * label pages, so a delivery is never rejected over them.
 */
export const decodePullRequestSnapshot = (
  rawBody: ArrayBuffer,
): Effect.Effect<Option.Option<PullRequestSnapshot>> =>
  Schema.decodeUnknown(Schema.parseJson(PullRequestDetailsWebhook))(
    new TextDecoder().decode(rawBody),
  ).pipe(
    Effect.map(
      ({
        number,
        pull_request: pullRequest,
        repository,
      }): PullRequestSnapshot => ({
        githubRepositoryId: repository.id,
        number,
        title: pullRequest.title,
        authorLogin: pullRequest.user.login,
        headRef: pullRequest.head.ref,
        baseRef: pullRequest.base.ref,
        state: pullRequest.merged_at !== null ? "merged" : pullRequest.state,
        draft: pullRequest.draft ?? false,
        githubUpdatedAt: pullRequest.updated_at,
      }),
    ),
    Effect.option,
  );

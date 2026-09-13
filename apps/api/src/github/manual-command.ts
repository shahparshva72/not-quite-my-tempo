import { Effect, Option, Schema } from "effect";

import { GitHubId } from "./review-request.js";

export const MANUAL_REVIEW_COMMAND = "/fletcher again";

// Only people with write-ish standing on the repository may command a
// re-review; drive-by commenters cannot burn the daily cap.
const ALLOWED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

const IssueCommentWebhook = Schema.Struct({
  action: Schema.Literal("created"),
  comment: Schema.Struct({
    body: Schema.String,
    author_association: Schema.String,
  }),
  issue: Schema.Struct({
    number: GitHubId,
    // Present only when the issue is a pull request.
    pull_request: Schema.Struct({ url: Schema.String }),
  }),
  installation: Schema.Struct({ id: GitHubId }),
  repository: Schema.Struct({
    id: GitHubId,
    name: Schema.NonEmptyString,
    default_branch: Schema.NonEmptyString,
    owner: Schema.Struct({
      id: GitHubId,
      login: Schema.NonEmptyString,
      type: Schema.NonEmptyString,
    }),
  }),
});

export interface ManualReviewCommand {
  readonly installationId: number;
  readonly installationAccountId: number;
  readonly installationAccountType: string;
  readonly githubRepositoryId: number;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly pullRequestNumber: number;
}

/**
 * Decodes an `issue_comment` delivery into a manual review command. Returns
 * `None` for anything that is not a newly created `/fletcher again` comment
 * on a pull request in an installation repository — those deliveries are
 * ignored rather than rejected.
 */
export const decodeIssueCommentBody = (
  rawBody: ArrayBuffer,
): Effect.Effect<Option.Option<ManualReviewCommand>> =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(rawBody);

    const webhook = yield* Schema.decodeUnknown(
      Schema.parseJson(IssueCommentWebhook),
    )(json).pipe(Effect.option);

    return Option.flatMap(webhook, (payload) =>
      payload.comment.body
        .trim()
        .toLowerCase()
        .startsWith(MANUAL_REVIEW_COMMAND) &&
      ALLOWED_AUTHOR_ASSOCIATIONS.has(payload.comment.author_association)
        ? Option.some<ManualReviewCommand>({
            installationId: payload.installation.id,
            installationAccountId: payload.repository.owner.id,
            installationAccountType: payload.repository.owner.type,
            githubRepositoryId: payload.repository.id,
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            defaultBranch: payload.repository.default_branch,
            pullRequestNumber: payload.issue.number,
          })
        : Option.none(),
    );
  });

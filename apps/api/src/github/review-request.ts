import { Data, Effect, Option, Schema } from "effect";

export const ReviewTrigger = Schema.Literal(
  "opened",
  "synchronize",
  "reopened",
);

export type ReviewTrigger = typeof ReviewTrigger.Type;

export const ReviewRequestTrigger = Schema.Literal(
  "opened",
  "synchronize",
  "reopened",
  "manual",
);

export type ReviewRequestTrigger = typeof ReviewRequestTrigger.Type;

export const GitHubId = Schema.Number.pipe(Schema.int(), Schema.positive());

export const ReviewRequest = Schema.Struct({
  installationId: GitHubId,
  installationAccountId: GitHubId,
  installationAccountType: Schema.NonEmptyString,
  githubRepositoryId: GitHubId,
  owner: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  defaultBranch: Schema.NonEmptyString,
  pullRequestNumber: GitHubId,
  headSha: Schema.NonEmptyString,
  trigger: ReviewRequestTrigger,
});

export type ReviewRequest = typeof ReviewRequest.Type;

// Webhook deliveries can only produce the three pull_request actions;
// "manual" comes from the /fletcher again comment command.
const WebhookReviewRequest = Schema.Struct({
  ...ReviewRequest.fields,
  trigger: ReviewTrigger,
});

const ActionEnvelope = Schema.Struct({ action: Schema.String });

const PullRequestWebhook = Schema.Struct({
  action: ReviewTrigger,
  installation: Schema.Struct({ id: GitHubId }),
  number: GitHubId,
  pull_request: Schema.Struct({
    head: Schema.Struct({ sha: Schema.NonEmptyString }),
  }),
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

const NormalizedPullRequestWebhook = Schema.transform(
  PullRequestWebhook,
  WebhookReviewRequest,
  {
    strict: true,
    decode: (webhook) => ({
      installationId: webhook.installation.id,
      installationAccountId: webhook.repository.owner.id,
      installationAccountType: webhook.repository.owner.type,
      githubRepositoryId: webhook.repository.id,
      owner: webhook.repository.owner.login,
      repo: webhook.repository.name,
      defaultBranch: webhook.repository.default_branch,
      pullRequestNumber: webhook.number,
      headSha: webhook.pull_request.head.sha,
      trigger: webhook.action,
    }),
    encode: (request) => ({
      action: request.trigger,
      installation: { id: request.installationId },
      number: request.pullRequestNumber,
      pull_request: { head: { sha: request.headSha } },
      repository: {
        id: request.githubRepositoryId,
        name: request.repo,
        default_branch: request.defaultBranch,
        owner: {
          id: request.installationAccountId,
          login: request.owner,
          type: request.installationAccountType,
        },
      },
    }),
  },
);

export class InvalidGitHubPayloadError extends Data.TaggedError(
  "InvalidGitHubPayloadError",
)<{
  readonly message: string;
}> {}

const invalidPayload = () =>
  new InvalidGitHubPayloadError({
    message: "GitHub webhook payload does not match the expected schema",
  });

export const decodePullRequestBody = (rawBody: ArrayBuffer) =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(rawBody);

    const envelope = yield* Schema.decodeUnknown(
      Schema.parseJson(ActionEnvelope),
    )(json).pipe(Effect.mapError(invalidPayload));

    const supportedAction = yield* Schema.decodeUnknown(ReviewTrigger)(
      envelope.action,
    ).pipe(Effect.option);

    return yield* Option.match(supportedAction, {
      onNone: () => Effect.succeed(Option.none<ReviewRequest>()),
      onSome: () =>
        Schema.decodeUnknown(Schema.parseJson(NormalizedPullRequestWebhook))(
          json,
        ).pipe(
          Effect.map((request): Option.Option<ReviewRequest> =>
            Option.some(request),
          ),
          Effect.mapError(invalidPayload),
        ),
    });
  });

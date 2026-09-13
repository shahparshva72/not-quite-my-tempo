import { Context, Data, Effect, Layer, Option, Schema } from "effect";

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

const USER_AGENT = "not-quite-my-tempo";

// Diffs beyond this size blow past useful review-model context and usually
// indicate generated churn; the Workflow reports them instead of reviewing.
const DEFAULT_MAX_DIFF_BYTES = 300_000;

export class PullRequestRequestError extends Data.TaggedError(
  "PullRequestRequestError",
)<{
  readonly cause: unknown;
}> {}

export class PullRequestResponseError extends Data.TaggedError(
  "PullRequestResponseError",
)<{
  readonly status: number;
  readonly body: string;
}> {}

export class PullRequestDiffTooLargeError extends Data.TaggedError(
  "PullRequestDiffTooLargeError",
)<{
  readonly sizeBytes: number;
  readonly maxDiffBytes: number;
}> {}

export type PullRequestClientError =
  | PullRequestRequestError
  | PullRequestResponseError
  | PullRequestDiffTooLargeError;

export class ReviewSubmitRequestError extends Data.TaggedError(
  "ReviewSubmitRequestError",
)<{
  readonly cause: unknown;
}> {}

export class ReviewSubmitResponseError extends Data.TaggedError(
  "ReviewSubmitResponseError",
)<{
  readonly status: number;
  readonly body: string;
}> {}

export type ReviewSubmitError =
  | ReviewSubmitRequestError
  | ReviewSubmitResponseError;

export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
}

const PullRequestDetailsResponse = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  base: Schema.Struct({
    ref: Schema.NonEmptyString,
    sha: Schema.NonEmptyString,
  }),
  head: Schema.Struct({ sha: Schema.NonEmptyString }),
});

export interface PullRequestDetails {
  readonly title: string;
  readonly body: string | null;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewCommentInput {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface CreateReviewInput {
  readonly commitId: string;
  readonly body: string;
  readonly comments: readonly ReviewCommentInput[];
}

const CreatedReviewResponse = Schema.Struct({ id: Schema.Number });

const ReviewCommentsResponse = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    path: Schema.String,
    line: Schema.optionalWith(Schema.NullOr(Schema.Number), {
      default: () => null,
    }),
    body: Schema.String,
  }),
);

export interface PostedReviewComment {
  readonly id: number;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
}

export interface GitHubPullRequestClientService {
  readonly fetchDiff: (
    installationToken: string,
    ref: PullRequestRef,
  ) => Effect.Effect<string, PullRequestClientError>;
  readonly fetchDetails: (
    installationToken: string,
    ref: PullRequestRef,
  ) => Effect.Effect<
    PullRequestDetails,
    PullRequestRequestError | PullRequestResponseError
  >;
  readonly createReview: (
    installationToken: string,
    ref: PullRequestRef,
    review: CreateReviewInput,
  ) => Effect.Effect<{ readonly reviewId: number }, ReviewSubmitError>;
  readonly listReviewComments: (
    installationToken: string,
    ref: PullRequestRef,
    reviewId: number,
  ) => Effect.Effect<readonly PostedReviewComment[], ReviewSubmitError>;
  readonly fetchRepositoryFile: (
    installationToken: string,
    ref: PullRequestRef,
    filePath: string,
    gitRef: string,
  ) => Effect.Effect<
    Option.Option<string>,
    PullRequestRequestError | PullRequestResponseError
  >;
}

export class GitHubPullRequestClient extends Context.Tag(
  "@not-quite-my-tempo/api/GitHubPullRequestClient",
)<GitHubPullRequestClient, GitHubPullRequestClientService>() {}

export interface GitHubPullRequestClientConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxDiffBytes?: number;
}

const fetchPullRequestBody = (
  config: GitHubPullRequestClientConfig,
  installationToken: string,
  ref: PullRequestRef,
  accept: string,
) =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl ?? GITHUB_API_BASE_URL;

    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `${baseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.pullRequestNumber}`,
          {
            method: "GET",
            headers: {
              accept,
              authorization: `Bearer ${installationToken}`,
              "user-agent": USER_AGENT,
              "x-github-api-version": GITHUB_API_VERSION,
            },
          },
        ),
      catch: (cause) => new PullRequestRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new PullRequestRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new PullRequestResponseError({
        status: response.status,
        body,
      });
    }

    return body;
  });

const submitRequest = (
  config: GitHubPullRequestClientConfig,
  installationToken: string,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: string },
) =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl ?? GITHUB_API_BASE_URL;

    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, requestInit?: RequestInit) =>
        globalThis.fetch(input, requestInit));

    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${installationToken}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    };

    const requestInit: RequestInit =
      init.body === undefined
        ? { method: init.method, headers }
        : { method: init.method, headers, body: init.body };

    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(`${baseUrl}${path}`, requestInit),
      catch: (cause) => new ReviewSubmitRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new ReviewSubmitRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new ReviewSubmitResponseError({
        status: response.status,
        body,
      });
    }

    return body;
  });

export const GitHubPullRequestClientLive = (
  config: GitHubPullRequestClientConfig,
) =>
  Layer.succeed(
    GitHubPullRequestClient,
    GitHubPullRequestClient.of({
      fetchDiff: (installationToken, ref) =>
        Effect.gen(function* () {
          const diff = yield* fetchPullRequestBody(
            config,
            installationToken,
            ref,
            "application/vnd.github.diff",
          );

          const maxDiffBytes = config.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
          const sizeBytes = new TextEncoder().encode(diff).byteLength;

          if (sizeBytes > maxDiffBytes) {
            return yield* new PullRequestDiffTooLargeError({
              sizeBytes,
              maxDiffBytes,
            });
          }

          return diff;
        }),
      fetchDetails: (installationToken, ref) =>
        Effect.gen(function* () {
          const body = yield* fetchPullRequestBody(
            config,
            installationToken,
            ref,
            "application/vnd.github+json",
          );

          const decoded = yield* Schema.decodeUnknown(
            Schema.parseJson(PullRequestDetailsResponse),
          )(body).pipe(
            Effect.mapError((cause) => new PullRequestRequestError({ cause })),
          );

          return {
            title: decoded.title,
            body: decoded.body,
            baseRef: decoded.base.ref,
            baseSha: decoded.base.sha,
            headSha: decoded.head.sha,
          };
        }),
      createReview: (installationToken, ref, review) =>
        Effect.gen(function* () {
          const body = yield* submitRequest(
            config,
            installationToken,
            `/repos/${ref.owner}/${ref.repo}/pulls/${ref.pullRequestNumber}/reviews`,
            {
              method: "POST",
              body: JSON.stringify({
                commit_id: review.commitId,
                body: review.body,
                event: "COMMENT",
                comments: review.comments.map((comment) => ({
                  path: comment.path,
                  line: comment.line,
                  side: "RIGHT",
                  body: comment.body,
                })),
              }),
            },
          );

          const decoded = yield* Schema.decodeUnknown(
            Schema.parseJson(CreatedReviewResponse),
          )(body).pipe(
            Effect.mapError((cause) => new ReviewSubmitRequestError({ cause })),
          );

          return { reviewId: decoded.id };
        }),
      fetchRepositoryFile: (installationToken, ref, filePath, gitRef) =>
        Effect.gen(function* () {
          const baseUrl = config.baseUrl ?? GITHUB_API_BASE_URL;

          const fetchImpl =
            config.fetchImpl ??
            ((input: RequestInfo | URL, init?: RequestInit) =>
              globalThis.fetch(input, init));

          const response = yield* Effect.tryPromise({
            try: () =>
              fetchImpl(
                `${baseUrl}/repos/${ref.owner}/${ref.repo}/contents/${filePath}?ref=${gitRef}`,
                {
                  method: "GET",
                  headers: {
                    accept: "application/vnd.github.raw+json",
                    authorization: `Bearer ${installationToken}`,
                    "user-agent": USER_AGENT,
                    "x-github-api-version": GITHUB_API_VERSION,
                  },
                },
              ),
            catch: (cause) => new PullRequestRequestError({ cause }),
          });

          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) => new PullRequestRequestError({ cause }),
          });

          if (response.status === 404) {
            return Option.none<string>();
          }

          if (!response.ok) {
            return yield* new PullRequestResponseError({
              status: response.status,
              body,
            });
          }

          return Option.some(body);
        }),
      listReviewComments: (installationToken, ref, reviewId) =>
        Effect.gen(function* () {
          const body = yield* submitRequest(
            config,
            installationToken,
            `/repos/${ref.owner}/${ref.repo}/pulls/${ref.pullRequestNumber}/reviews/${reviewId}/comments`,
            { method: "GET" },
          );

          return yield* Schema.decodeUnknown(
            Schema.parseJson(ReviewCommentsResponse),
          )(body).pipe(
            Effect.mapError((cause) => new ReviewSubmitRequestError({ cause })),
          );
        }),
    }),
  );

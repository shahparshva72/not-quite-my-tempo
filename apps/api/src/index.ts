import { Data, Effect, Inspectable, Match, Schema } from "effect";
import { Hono } from "hono";
import { logger } from "hono/logger";
import {
  Database,
  DatabaseLive,
  makeLiveLayer,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import { makeServiceInfo } from "@not-quite-my-tempo/core";
import type { Context } from "hono";

import { ReviewWorkflowLive } from "./application/review-requests.js";
import type { ReviewWorkflowParams } from "./application/review-requests.js";
import { GitHubAppAuthLive } from "./github/app-auth.js";
import { GitHubPullRequestClientLive } from "./github/pull-request-client.js";
import { processGitHubWebhook } from "./github/webhook.js";
import { logError } from "./logging.js";

export { ReviewPullRequestWorkflow } from "./workflows/review-pull-request.js";

type Bindings = Env & {
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly REVIEW_PULL_REQUEST_WORKFLOW: Workflow<ReviewWorkflowParams>;
};

type AppContext = Context<{ Bindings: Bindings }>;

const serviceInfo = makeServiceInfo("not-quite-my-tempo-api");

const healthCheck = Effect.gen(function* () {
  yield* Database;

  return yield* serviceInfo.health;
});

const DebugReviewRunInput = Schema.Struct({
  repositoryId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  pullRequestNumber: Schema.Number.pipe(Schema.int(), Schema.positive()),
  headSha: Schema.NonEmptyString,
  trigger: Schema.Literal("opened", "synchronize", "reopened", "manual"),
  model: Schema.optional(Schema.NullOr(Schema.String)),
});

class RequestBodyError extends Data.TaggedError("RequestBodyError")<{
  readonly cause: unknown;
}> {}

const createDebugReviewRun = (rawBody: string) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(
      Schema.parseJson(DebugReviewRunInput),
    )(rawBody);

    return yield* ReviewRunRepository.create({
      ...input,
      model: input.model ?? null,
    });
  });

const app = new Hono<{ Bindings: Bindings }>();

const errorResponse = (
  c: AppContext,
  status: 400 | 401 | 404 | 500,
  code: string,
  message: string,
) => c.json({ error: { code, message } }, status);

const internalError = (c: AppContext, cause: unknown) => {
  Effect.runSync(
    logError("request_failed", {
      error: Inspectable.toStringUnknown(cause),
    }),
  );

  return errorResponse(c, 500, "internal_error", "Internal server error");
};

app.use("*", logger());

app.get("/", (c) =>
  c.json({
    name: serviceInfo.name,
    message: "Hono on Cloudflare Workers with D1 and Effect",
  }),
);

app.get("/health", (c) =>
  Effect.runPromise(
    healthCheck.pipe(
      Effect.provide(DatabaseLive(c.env.DB)),
      Effect.match({
        onFailure: (cause) => internalError(c, cause),
        onSuccess: (result) => c.json(result),
      }),
    ),
  ),
);

app.post("/webhooks/github", (c) => {
  const githubEvent = c.req.header("x-github-event") ?? "unknown";

  return Effect.runPromise(
    Effect.tryPromise({
      try: () => c.req.arrayBuffer(),
      catch: (cause) => new RequestBodyError({ cause }),
    }).pipe(
      Effect.flatMap((rawBody) =>
        processGitHubWebhook(
          rawBody,
          c.req.header("x-hub-signature-256"),
          githubEvent,
          c.env.GITHUB_WEBHOOK_SECRET,
        ),
      ),
      Effect.provide(makeLiveLayer(c.env.DB)),
      Effect.provide(ReviewWorkflowLive(c.env.REVIEW_PULL_REQUEST_WORKFLOW)),
      Effect.provide(
        GitHubAppAuthLive({
          appId: c.env.GITHUB_APP_ID,
          privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
        }),
      ),
      Effect.provide(GitHubPullRequestClientLive({})),
      Effect.match({
        onFailure: (cause) =>
          Match.value(cause).pipe(
            Match.tag("InvalidWebhookSignatureError", () =>
              errorResponse(
                c,
                401,
                "invalid_signature",
                "GitHub webhook signature is invalid",
              ),
            ),
            Match.tag("InvalidGitHubPayloadError", (error) =>
              errorResponse(c, 400, "invalid_payload", error.message),
            ),
            Match.orElse((error) => internalError(c, error)),
          ),
        onSuccess: (result) => c.json(result, 202),
      }),
    ),
  );
});

app.post("/debug/review-runs", (c) =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => c.req.text(),
      catch: (cause) => new RequestBodyError({ cause }),
    }).pipe(
      Effect.flatMap(createDebugReviewRun),
      Effect.provide(makeLiveLayer(c.env.DB)),
      Effect.match({
        onFailure: (cause) =>
          Match.value(cause).pipe(
            Match.tag("ParseError", () =>
              errorResponse(
                c,
                400,
                "invalid_payload",
                "Request body does not match the expected schema",
              ),
            ),
            Match.orElse((error) => internalError(c, error)),
          ),
        onSuccess: (reviewRun) => c.json(reviewRun),
      }),
    ),
  ),
);

app.notFound((c) => errorResponse(c, 404, "not_found", "Route not found"));

app.onError((error, c) => internalError(c, error));

export default app;

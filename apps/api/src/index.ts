import { Data, Effect, Inspectable, Match, Option } from "effect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { logger } from "hono/logger";
import { Database, DatabaseLive, makeLiveLayer } from "@not-quite-my-tempo/db";
import { makeServiceInfo } from "@not-quite-my-tempo/core";
import type { Context } from "hono";

import { ReviewWorkflowLive } from "./application/review-requests.js";
import type { ReviewWorkflowParams } from "./application/review-requests.js";
import {
  listAccessibleRepositories,
  listRepositoryRuns,
  listRunFindings,
  usageSummary,
} from "./application/read-api.js";
import {
  authorizeUrl,
  GitHubOAuth,
  GitHubOAuthLive,
} from "./auth/github-oauth.js";
import {
  createSession,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySession,
} from "./auth/session.js";
import type { SessionPayload } from "./auth/session.js";
import {
  dashboardPage,
  landingPage,
  notFoundPage,
  repositoryRunsPage,
  runFindingsPage,
} from "./dashboard/views.js";
import { GitHubAppAuthLive } from "./github/app-auth.js";
import { GitHubPullRequestClientLive } from "./github/pull-request-client.js";
import { processGitHubWebhook } from "./github/webhook.js";
import { logError } from "./logging.js";

export { ReviewPullRequestWorkflow } from "./workflows/review-pull-request.js";

type Bindings = Env & {
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly SESSION_SECRET: string;
  readonly REVIEW_PULL_REQUEST_WORKFLOW: Workflow<ReviewWorkflowParams>;
};

type AppContext = Context<{ Bindings: Bindings }>;

const serviceInfo = makeServiceInfo("not-quite-my-tempo-api");

const healthCheck = Effect.gen(function* () {
  yield* Database;

  return yield* serviceInfo.health;
});

class RequestBodyError extends Data.TaggedError("RequestBodyError")<{
  readonly cause: unknown;
}> {}

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

const stateCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: 600,
} as const;

app.get("/auth/login", (c) => {
  const state = crypto.randomUUID();

  setCookie(c, OAUTH_STATE_COOKIE, state, stateCookieOptions);

  return c.redirect(authorizeUrl(c.env.GITHUB_OAUTH_CLIENT_ID, state));
});

app.get("/auth/callback", (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE);

  if (
    code === undefined ||
    state === undefined ||
    expectedState === undefined ||
    state !== expectedState
  ) {
    return Promise.resolve(
      errorResponse(c, 401, "invalid_oauth_state", "OAuth state mismatch"),
    );
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const oauth = yield* GitHubOAuth;

      const accessToken = yield* oauth.exchangeCode(code);
      const login = yield* oauth.fetchUserLogin(accessToken);

      const installationIds =
        yield* oauth.fetchUserInstallationIds(accessToken);

      return yield* createSession(c.env.SESSION_SECRET, login, installationIds);
    }).pipe(
      Effect.provide(
        GitHubOAuthLive({
          clientId: c.env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
        }),
      ),
      Effect.match({
        onFailure: (cause) => internalError(c, cause),
        onSuccess: (sessionCookie) => {
          deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
          setCookie(c, SESSION_COOKIE, sessionCookie, {
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            path: "/",
            maxAge: SESSION_TTL_SECONDS,
          });

          return c.redirect("/");
        },
      }),
    ),
  );
});

app.get("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.redirect("/");
});

const withSession = (
  c: AppContext,
  handle: (session: SessionPayload) => Promise<Response>,
) =>
  Effect.runPromise(
    verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)),
  ).then(
    Option.match({
      onNone: () =>
        Promise.resolve(
          errorResponse(c, 401, "unauthorized", "Sign in at /auth/login"),
        ),
      onSome: handle,
    }),
  );

const withSessionPage = (
  c: AppContext,
  handle: (session: SessionPayload) => Promise<Response | Promise<Response>>,
): Promise<Response> =>
  Effect.runPromise(
    verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)),
  )
    .then(
      Option.match({
        onNone: () => Promise.resolve(c.html(landingPage())),
        onSome: handle,
      }),
    )
    .then((response) => Promise.resolve(response));

app.get("/dashboard", (c) =>
  withSessionPage(c, (session) =>
    Effect.runPromise(
      usageSummary(session.installationIds).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) => internalError(c, cause),
          onSuccess: (usage) => c.html(dashboardPage(session.login, usage)),
        }),
      ),
    ),
  ),
);

app.get("/dashboard/repositories/:id", (c) =>
  withSessionPage(c, (session) => {
    const repositoryId = Number(c.req.param("id"));

    if (!Number.isInteger(repositoryId)) {
      return Promise.resolve(c.html(notFoundPage(), 404));
    }

    return Effect.runPromise(
      listRepositoryRuns(session.installationIds, repositoryId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ repository, runs }) =>
            c.html(repositoryRunsPage(repository, runs)),
        }),
      ),
    );
  }),
);

app.get("/dashboard/runs/:id", (c) =>
  withSessionPage(c, (session) => {
    const reviewRunId = Number(c.req.param("id"));

    if (!Number.isInteger(reviewRunId)) {
      return Promise.resolve(c.html(notFoundPage(), 404));
    }

    return Effect.runPromise(
      listRunFindings(session.installationIds, reviewRunId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ run, findings }) =>
            c.html(runFindingsPage(run, findings)),
        }),
      ),
    );
  }),
);

app.get("/api/repositories", (c) =>
  withSession(c, (session) =>
    Effect.runPromise(
      listAccessibleRepositories(session.installationIds).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) => internalError(c, cause),
          onSuccess: (repositories) => c.json({ repositories }),
        }),
      ),
    ),
  ),
);

app.get("/api/repositories/:id/runs", (c) =>
  withSession(c, (session) => {
    const repositoryId = Number(c.req.param("id"));

    if (!Number.isInteger(repositoryId)) {
      return Promise.resolve(
        errorResponse(c, 400, "invalid_id", "Repository id must be an integer"),
      );
    }

    return Effect.runPromise(
      listRepositoryRuns(session.installationIds, repositoryId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                errorResponse(c, 404, "not_found", "Repository not found"),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: (result) => c.json(result),
        }),
      ),
    );
  }),
);

app.get("/api/runs/:id/findings", (c) =>
  withSession(c, (session) => {
    const reviewRunId = Number(c.req.param("id"));

    if (!Number.isInteger(reviewRunId)) {
      return Promise.resolve(
        errorResponse(c, 400, "invalid_id", "Run id must be an integer"),
      );
    }

    return Effect.runPromise(
      listRunFindings(session.installationIds, reviewRunId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                errorResponse(c, 404, "not_found", "Review run not found"),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: (result) => c.json(result),
        }),
      ),
    );
  }),
);

app.get("/api/usage", (c) =>
  withSession(c, (session) =>
    Effect.runPromise(
      usageSummary(session.installationIds).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) => internalError(c, cause),
          onSuccess: (usage) => c.json({ usage }),
        }),
      ),
    ),
  ),
);

app.notFound((c) => errorResponse(c, 404, "not_found", "Route not found"));

app.onError((error, c) => internalError(c, error));

export default app;

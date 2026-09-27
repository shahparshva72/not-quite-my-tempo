import { Data, Effect, Inspectable, Match, Option } from "effect";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { logger } from "hono/logger";
import {
  Database,
  DatabaseLive,
  GitHubRepositoryRepository,
  makeLiveLayer,
} from "@not-quite-my-tempo/db";
import { makeServiceInfo } from "@not-quite-my-tempo/core";
import type { Context } from "hono";

import { ReviewWorkflowLive } from "./application/review-requests.js";
import type { ReviewWorkflowParams } from "./application/review-requests.js";
import {
  listAccessibleRepositories,
  listRepositoryRuns,
  listRunFindings,
  requireAccessibleRepository,
  usageSummary,
} from "./application/read-api.js";
import { createAuthRoutes } from "./auth/routes.js";
import {
  PENDING_INSTALLATION_COOKIE,
  SESSION_COOKIE,
  verifySession,
} from "./auth/session.js";
import type { SessionPayload } from "./auth/session.js";
import {
  dashboardPage,
  installationPendingPage,
  landingPage,
  notFoundPage,
  onboardingPage,
  repositoryRunsPage,
  runFindingsPage,
} from "./dashboard/views.js";
import { GitHubAppAuthLive } from "./github/app-auth.js";
import { GitHubInstallationClientLive } from "./github/installation-client.js";
import { GitHubPullRequestClientLive } from "./github/pull-request-client.js";
import { processGitHubWebhook } from "./github/webhook.js";
import { logError } from "./logging.js";

export { ReviewPullRequestWorkflow } from "./workflows/review-pull-request.js";

type Bindings = Env & {
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_APP_SLUG: string;
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
  status: 400 | 401 | 403 | 404 | 500,
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

app.use("*", async (c, next) => {
  const path = c.req.path;

  if (
    path.startsWith("/api/") ||
    path === "/dashboard" ||
    path.startsWith("/dashboard/")
  ) {
    c.header("Cache-Control", "no-store");
  }

  if (path.startsWith("/auth/")) {
    await next();
  } else {
    await logger()(c, next);
  }
});

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
      Effect.provide(GitHubInstallationClientLive({})),
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

app.route("/auth", createAuthRoutes());

const withSession = (
  c: AppContext,
  handle: (session: SessionPayload) => Promise<Response>,
) =>
  Effect.runPromise(
    verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)).pipe(
      Effect.provide(makeLiveLayer(c.env.DB)),
    ),
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
    verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)).pipe(
      Effect.provide(makeLiveLayer(c.env.DB)),
    ),
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
      usageSummary(session.repositoryIds).pipe(
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
      return Promise.resolve(c.html(notFoundPage(session.login), 404));
    }

    return Effect.runPromise(
      listRepositoryRuns(session.repositoryIds, repositoryId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ repository, runs }) =>
            c.html(repositoryRunsPage(session.login, repository, runs)),
        }),
      ),
    );
  }),
);

app.get("/dashboard/runs/:id", (c) =>
  withSessionPage(c, (session) => {
    const reviewRunId = Number(c.req.param("id"));

    if (!Number.isInteger(reviewRunId)) {
      return Promise.resolve(c.html(notFoundPage(session.login), 404));
    }

    return Effect.runPromise(
      listRunFindings(session.repositoryIds, reviewRunId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ run, findings }) =>
            c.html(runFindingsPage(session.login, run, findings)),
        }),
      ),
    );
  }),
);

app.get("/", (c) =>
  withSessionPage(c, () => Promise.resolve(c.redirect("/dashboard"))),
);

app.get("/onboarding", (c) =>
  withSessionPage(c, (session) => {
    const appSlug = c.env.GITHUB_APP_SLUG;

    if (appSlug === undefined || appSlug === "") {
      return Promise.resolve(
        internalError(c, new Error("GITHUB_APP_SLUG is not configured")),
      );
    }

    return Effect.runPromise(
      listAccessibleRepositories(session.repositoryIds).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) => internalError(c, cause),
          onSuccess: (repositories) =>
            c.html(
              onboardingPage(
                session.login,
                `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
                repositories,
              ),
            ),
        }),
      ),
    );
  }),
);

// GitHub App "Setup URL". The installation_id here is untrusted: it is held
// in a short-lived cookie until sign-in confirms the user can see it.
app.get("/onboarding/callback", (c) => {
  if (c.req.query("setup_action") === "request") {
    return c.html(installationPendingPage());
  }

  const installationId = Number(c.req.query("installation_id"));

  if (!Number.isInteger(installationId) || installationId <= 0) {
    return c.redirect("/onboarding");
  }

  setCookie(c, PENDING_INSTALLATION_COOKIE, String(installationId), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  return c.redirect("/auth/login?next=onboarding");
});

app.post("/onboarding/repositories/:id", (c) => {
  if (c.req.header("origin") !== new URL(c.req.url).origin) {
    return Promise.resolve(
      errorResponse(c, 403, "invalid_origin", "Same-origin request required"),
    );
  }

  return withSessionPage(c, async (session) => {
    const repositoryId = Number(c.req.param("id"));
    const form = await c.req.parseBody();
    const enabled = form["enabled"];

    if (
      !Number.isInteger(repositoryId) ||
      (enabled !== "true" && enabled !== "false")
    ) {
      return c.html(notFoundPage(session.login), 404);
    }

    return Effect.runPromise(
      requireAccessibleRepository(session.repositoryIds, repositoryId).pipe(
        Effect.flatMap((repository) =>
          GitHubRepositoryRepository.setEnabled(
            repository.id,
            enabled === "true",
          ),
        ),
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: () => c.redirect("/onboarding", 303),
        }),
      ),
    );
  });
});

app.get("/api/me", (c) =>
  withSession(c, (session) =>
    Promise.resolve(
      c.json({
        user: {
          id: session.userId,
          githubUserId: session.githubUserId,
          login: session.login,
        },
        session: { expiresAt: session.expiresAt },
      }),
    ),
  ),
);

app.get("/api/repositories", (c) =>
  withSession(c, (session) =>
    Effect.runPromise(
      listAccessibleRepositories(session.repositoryIds).pipe(
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
      listRepositoryRuns(session.repositoryIds, repositoryId).pipe(
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
      listRunFindings(session.repositoryIds, reviewRunId).pipe(
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
      usageSummary(session.repositoryIds).pipe(
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

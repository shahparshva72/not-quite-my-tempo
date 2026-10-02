import { Data, Effect, Inspectable, Match, Option, Schema } from "effect";
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
  dashboardOverview,
  listAccessibleRepositories,
  listRepositoryRuns,
  listRunFindings,
  repositoryReviewHistory,
  reviewDetail,
  usageSummary,
} from "./application/read-api.js";
import {
  authorizeRepository,
  visibleRepositories,
} from "./application/authorization.js";
import {
  handlePolarWebhook,
  openBillingPortal,
  startCheckout,
} from "./application/billing.js";
import type { BillingLink } from "./application/billing.js";
import { refreshSessionAccess } from "./application/session-access.js";
import {
  recoverStuckRuns,
  ReviewWorkflowStatusLive,
} from "./application/stuck-runs.js";
import {
  changeAdminRole,
  workspaceMembers,
} from "./application/workspace-members.js";
import {
  GeminiKeyCheckerLive,
  removeGeminiKey,
  saveGeminiKey,
  workspaceSettings,
} from "./application/workspace-settings.js";
import { GitHubOAuthLive } from "./auth/github-oauth.js";
import { cachedPlanPrice } from "./billing/plan-price.js";
import { PolarClientLive, polarConfig } from "./billing/polar-client.js";
import {
  decodePolarWebhookEvent,
  verifyPolarWebhook,
} from "./billing/polar-webhook.js";
import { createAuthRoutes } from "./auth/routes.js";
import {
  PENDING_INSTALLATION_COOKIE,
  SESSION_COOKIE,
  verifySession,
} from "./auth/session.js";
import type { SessionPayload } from "./auth/session.js";
import {
  dashboardPage,
  forbiddenPage,
  installationPendingPage,
  landingPage,
  membersPage,
  notFoundPage,
  onboardingPage,
  ownerRolePage,
  settingsPage,
  repositoryRunsPage,
  runFindingsPage,
} from "./dashboard/views.js";
import type { PaidPlanOffer, SettingsNotice } from "./dashboard/views.js";
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
  readonly TOKEN_ENCRYPTION_KEY: string;
  // Billing is optional: unset means no paid plan (docs/BILLING.md).
  readonly POLAR_ACCESS_TOKEN?: string;
  readonly POLAR_WEBHOOK_SECRET?: string;
  readonly POLAR_PRODUCT_ID?: string;
  readonly POLAR_SERVER?: string;
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

// Every browser form post must come from this site; GitHub webhooks are
// authenticated by their signature instead.
app.use("*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.path.startsWith("/webhooks/")) {
    const sameOrigin = c.req.header("origin") === new URL(c.req.url).origin;
    const crossSite = c.req.header("sec-fetch-site") === "cross-site";

    if (!sameOrigin || crossSite) {
      return errorResponse(
        c,
        403,
        "invalid_origin",
        "Same-origin request required",
      );
    }
  }

  return next();
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
      Effect.provide(
        ReviewWorkflowLive(
          c.env.REVIEW_PULL_REQUEST_WORKFLOW,
          new URL(c.req.url).origin,
        ),
      ),
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

// Polar subscription events. The signature, not the origin, authenticates
// them. Each one only triggers a re-read of the workspace's subscriptions
// from Polar (docs/BILLING.md); failures return 500 so Polar retries.
app.post("/webhooks/polar", async (c): Promise<Response> => {
  const config = polarConfig(c.env);

  if (Option.isNone(config)) {
    return errorResponse(c, 404, "billing_disabled", "Billing is off");
  }

  return Effect.runPromise(
    Effect.tryPromise({
      try: () => c.req.text(),
      catch: (cause) => new RequestBodyError({ cause }),
    }).pipe(
      Effect.flatMap((body) =>
        verifyPolarWebhook(
          body,
          {
            id: c.req.header("webhook-id"),
            timestamp: c.req.header("webhook-timestamp"),
            signature: c.req.header("webhook-signature"),
          },
          config.value.webhookSecret,
          new Date(),
        ).pipe(
          Effect.flatMap((valid) =>
            valid
              ? handlePolarWebhook(decodePolarWebhookEvent(body)).pipe(
                  Effect.map((synced): Response => c.json({ synced }, 202)),
                )
              : Effect.succeed<Response>(
                  errorResponse(
                    c,
                    401,
                    "invalid_signature",
                    "Polar webhook signature is invalid",
                  ),
                ),
          ),
        ),
      ),
      Effect.provide(makeLiveLayer(c.env.DB)),
      Effect.provide(PolarClientLive(config.value)),
      Effect.catchAll((error) => Effect.succeed(internalError(c, error))),
    ),
  );
});

app.route("/auth", createAuthRoutes());

/**
 * The signed-in session for this request, with GitHub access re-read when
 * it is older than the refresh interval (docs/WORKSPACES_DESIGN.md).
 */
const currentSession = (c: AppContext) =>
  Effect.runPromise(
    verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<SessionPayload>()),
          onSome: (session) =>
            refreshSessionAccess(session, c.env.TOKEN_ENCRYPTION_KEY),
        }),
      ),
      Effect.provide(
        GitHubOAuthLive({
          clientId: c.env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
        }),
      ),
      Effect.provide(
        GitHubAppAuthLive({
          appId: c.env.GITHUB_APP_ID,
          privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
        }),
      ),
      Effect.provide(GitHubInstallationClientLive({})),
      Effect.provide(makeLiveLayer(c.env.DB)),
    ),
  );

const withSession = (
  c: AppContext,
  handle: (session: SessionPayload) => Promise<Response>,
) =>
  currentSession(c).then(
    Option.match({
      onNone: () =>
        Promise.resolve(
          errorResponse(c, 401, "unauthorized", "Sign in at /auth/login"),
        ),
      onSome: handle,
    }),
  );

/** Whether the paid plan is sold here, and its price from Polar. */
const paidPlanOffer = (c: AppContext): Promise<PaidPlanOffer> =>
  Option.match(polarConfig(c.env), {
    onNone: () =>
      Promise.resolve({ billingEnabled: false, price: Option.none() }),
    onSome: (config) =>
      Effect.runPromise(
        cachedPlanPrice(config).pipe(
          Effect.provide(PolarClientLive(config)),
          Effect.map((price) => ({ billingEnabled: true, price })),
        ),
      ),
  });

const withSessionPage = (
  c: AppContext,
  handle: (session: SessionPayload) => Promise<Response | Promise<Response>>,
): Promise<Response> =>
  currentSession(c)
    .then(
      Option.match({
        onNone: () =>
          paidPlanOffer(c).then((offer) => c.html(landingPage(offer))),
        onSome: handle,
      }),
    )
    .then((response) => Promise.resolve(response));

app.get("/dashboard", (c) =>
  withSessionPage(c, (session) =>
    Effect.runPromise(
      dashboardOverview(session).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) => internalError(c, cause),
          onSuccess: (overview) =>
            c.html(dashboardPage(session.login, overview, new Date())),
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
      repositoryReviewHistory(session, repositoryId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ repository, role, reviews }) =>
            c.html(
              repositoryRunsPage(
                session.login,
                repository,
                role,
                reviews,
                new Date(),
              ),
            ),
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
      reviewDetail(session, reviewRunId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: ({ repository, run, findings }) =>
            c.html(
              runFindingsPage(
                session.login,
                repository,
                run,
                findings,
                new Date(),
              ),
            ),
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
      visibleRepositories(session).pipe(
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

app.post("/onboarding/repositories/:id", (c) =>
  withSessionPage(c, async (session) => {
    const repositoryId = Number(c.req.param("id"));
    const form = await c.req.parseBody();
    const enabled = form["enabled"];

    // Only two known pages; anything else goes back to onboarding.
    const returnTo =
      form["return"] === "repository"
        ? `/dashboard/repositories/${repositoryId}`
        : "/onboarding";

    if (
      !Number.isInteger(repositoryId) ||
      (enabled !== "true" && enabled !== "false")
    ) {
      return c.html(notFoundPage(session.login), 404);
    }

    return Effect.runPromise(
      authorizeRepository(session, repositoryId, "toggle_reviews").pipe(
        Effect.flatMap((visible) =>
          GitHubRepositoryRepository.setEnabledWithAudit(
            visible.repository,
            enabled === "true",
            { workspaceId: visible.workspaceId, actorUserId: session.userId },
          ),
        ),
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.tag("ForbiddenError", (error) =>
                c.html(forbiddenPage(session.login, error.requiredRole), 403),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: () => c.redirect(returnTo, 303),
        }),
      ),
    );
  }),
);

app.get("/workspaces/:id/members", (c) =>
  withSessionPage(c, (session) => {
    const workspaceId = Number(c.req.param("id"));

    if (!Number.isInteger(workspaceId)) {
      return Promise.resolve(c.html(notFoundPage(session.login), 404));
    }

    return Effect.runPromise(
      workspaceMembers(session, workspaceId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: (data) => c.html(membersPage(session.login, data)),
        }),
      ),
    );
  }),
);

app.post("/workspaces/:id/members/:userId/role", (c) =>
  withSessionPage(c, async (session) => {
    const workspaceId = Number(c.req.param("id"));
    const targetUserId = Number(c.req.param("userId"));
    const role = (await c.req.parseBody())["role"];

    if (
      !Number.isInteger(workspaceId) ||
      !Number.isInteger(targetUserId) ||
      (role !== "admin" && role !== "member")
    ) {
      return c.html(notFoundPage(session.login), 404);
    }

    return Effect.runPromise(
      changeAdminRole(session, workspaceId, targetUserId, role).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.tag("ForbiddenError", (error) =>
                c.html(forbiddenPage(session.login, error.requiredRole), 403),
              ),
              Match.tag("OwnerRoleError", () =>
                c.html(ownerRolePage(session.login), 400),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: () =>
            c.redirect(`/workspaces/${workspaceId}/members`, 303),
        }),
      ),
    );
  }),
);

const GeminiKeyForm = Schema.Struct({ api_key: Schema.String });

const settingsNotices = new Map<string, SettingsNotice>([
  ["saved", "saved"],
  ["removed", "removed"],
  ["subscribed", "subscribed"],
]);

const renderSettings = (
  c: AppContext,
  session: SessionPayload,
  workspaceId: number,
  notice: SettingsNotice | null,
  status: 200 | 404 | 409 | 422 | 503,
) =>
  Effect.runPromise(
    workspaceSettings(session, workspaceId).pipe(
      Effect.provide(makeLiveLayer(c.env.DB)),
      Effect.match({
        onFailure: (cause) =>
          Match.value(cause).pipe(
            Match.tag("ResourceNotFoundError", () =>
              c.html(notFoundPage(session.login), 404),
            ),
            Match.orElse((error) => internalError(c, error)),
          ),
        onSuccess: (data) =>
          paidPlanOffer(c).then((offer) =>
            c.html(
              settingsPage(
                session.login,
                { ...data, offer },
                notice,
                new Date(),
              ),
              status,
            ),
          ),
      }),
    ),
  );

app.get("/workspaces/:id/settings", (c) =>
  withSessionPage(c, (session) => {
    const workspaceId = Number(c.req.param("id"));

    if (!Number.isInteger(workspaceId)) {
      return Promise.resolve(c.html(notFoundPage(session.login), 404));
    }

    return renderSettings(
      c,
      session,
      workspaceId,
      settingsNotices.get(c.req.query("notice") ?? "") ?? null,
      200,
    );
  }),
);

app.post("/workspaces/:id/settings/gemini-key", (c) =>
  withSessionPage(c, async (session) => {
    const workspaceId = Number(c.req.param("id"));

    if (!Number.isInteger(workspaceId)) {
      return c.html(notFoundPage(session.login), 404);
    }

    const form = Schema.decodeUnknownOption(GeminiKeyForm)(
      await c.req.parseBody(),
    );

    if (Option.isNone(form)) {
      return renderSettings(c, session, workspaceId, "invalid_format", 422);
    }

    return Effect.runPromise(
      saveGeminiKey(
        session,
        workspaceId,
        form.value.api_key,
        c.env.TOKEN_ENCRYPTION_KEY,
      ).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.provide(GeminiKeyCheckerLive),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                Promise.resolve(c.html(notFoundPage(session.login), 404)),
              ),
              Match.tag("ForbiddenError", (error) =>
                Promise.resolve(
                  c.html(forbiddenPage(session.login, error.requiredRole), 403),
                ),
              ),
              Match.tag("InvalidGeminiKeyError", (error) =>
                renderSettings(
                  c,
                  session,
                  workspaceId,
                  error.reason === "format" ? "invalid_format" : "rejected",
                  422,
                ),
              ),
              Match.tag("GeminiUnavailableError", () =>
                renderSettings(c, session, workspaceId, "unavailable", 503),
              ),
              Match.orElse((error) => Promise.resolve(internalError(c, error))),
            ),
          onSuccess: () =>
            Promise.resolve(
              c.redirect(
                `/workspaces/${workspaceId}/settings?notice=saved`,
                303,
              ),
            ),
        }),
      ),
    );
  }),
);

app.post("/workspaces/:id/settings/gemini-key/remove", (c) =>
  withSessionPage(c, (session) => {
    const workspaceId = Number(c.req.param("id"));

    if (!Number.isInteger(workspaceId)) {
      return Promise.resolve(c.html(notFoundPage(session.login), 404));
    }

    return Effect.runPromise(
      removeGeminiKey(session, workspaceId).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                c.html(notFoundPage(session.login), 404),
              ),
              Match.tag("ForbiddenError", (error) =>
                c.html(forbiddenPage(session.login, error.requiredRole), 403),
              ),
              Match.orElse((error) => internalError(c, error)),
            ),
          onSuccess: () =>
            c.redirect(
              `/workspaces/${workspaceId}/settings?notice=removed`,
              303,
            ),
        }),
      ),
    );
  }),
);

/** Sends an admin to Polar: checkout to subscribe, or the portal. */
const redirectToPolar = (c: AppContext, link: BillingLink) =>
  withSessionPage(c, async (session) => {
    const workspaceId = Number(c.req.param("id"));

    if (!Number.isInteger(workspaceId)) {
      return c.html(notFoundPage(session.login), 404);
    }

    const config = polarConfig(c.env);

    if (Option.isNone(config)) {
      return renderSettings(c, session, workspaceId, "billing_disabled", 404);
    }

    return Effect.runPromise(
      link(session, workspaceId, new URL(c.req.url).origin).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.provide(PolarClientLive(config.value)),
        Effect.match({
          onFailure: (cause) =>
            Match.value(cause).pipe(
              Match.tag("ResourceNotFoundError", () =>
                Promise.resolve(c.html(notFoundPage(session.login), 404)),
              ),
              Match.tag("ForbiddenError", (error) =>
                Promise.resolve(
                  c.html(forbiddenPage(session.login, error.requiredRole), 403),
                ),
              ),
              Match.tag("AlreadySubscribedError", () =>
                renderSettings(
                  c,
                  session,
                  workspaceId,
                  "already_subscribed",
                  409,
                ),
              ),
              Match.tag("NoBillingAccountError", () =>
                renderSettings(
                  c,
                  session,
                  workspaceId,
                  "no_billing_account",
                  409,
                ),
              ),
              Match.tag("PolarRequestError", (error) => {
                Effect.runSync(
                  logError("polar_request_failed", {
                    operation: error.operation,
                    status: error.status ?? "none",
                  }),
                );

                return renderSettings(
                  c,
                  session,
                  workspaceId,
                  "billing_unavailable",
                  503,
                );
              }),
              Match.orElse((error) => Promise.resolve(internalError(c, error))),
            ),
          onSuccess: (url) => Promise.resolve(c.redirect(url, 303)),
        }),
      ),
    );
  });

app.post("/workspaces/:id/billing/checkout", (c) =>
  redirectToPolar(c, startCheckout),
);

app.post("/workspaces/:id/billing/portal", (c) =>
  redirectToPolar(c, openBillingPortal),
);

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
      listAccessibleRepositories(session).pipe(
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
      listRepositoryRuns(session, repositoryId).pipe(
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
      listRunFindings(session, reviewRunId).pipe(
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
      usageSummary(session).pipe(
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

/**
 * Cron trigger (wrangler.jsonc): fails reviews whose workflow died without
 * finishing them, so the dashboard doesn't say "Reviewing now" forever.
 */
const scheduled = (
  _controller: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
) => {
  ctx.waitUntil(
    Effect.runPromise(
      recoverStuckRuns.pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(
          ReviewWorkflowStatusLive(env.REVIEW_PULL_REQUEST_WORKFLOW),
        ),
        Effect.catchAll((error) =>
          logError("stuck_runs_check_failed", {
            error: Inspectable.toStringUnknown(error),
          }),
        ),
      ),
    ),
  );
};

export default Object.assign(app, { scheduled });

import { Effect, Layer, Option } from "effect";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { makeLiveLayer, UserRepository } from "@not-quite-my-tempo/db";

import { syncUserInstallations } from "../application/installation-sync.js";
import { GitHubAppAuthLive } from "../github/app-auth.js";
import type { GitHubAppAuth } from "../github/app-auth.js";
import { GitHubInstallationClientLive } from "../github/installation-client.js";
import type { GitHubInstallationClient } from "../github/installation-client.js";
import { signInErrorPage } from "../dashboard/views.js";
import { logError } from "../logging.js";

import { authorizeUrl, GitHubOAuth, GitHubOAuthLive } from "./github-oauth.js";
import {
  createSession,
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  PENDING_INSTALLATION_COOKIE,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./session.js";

interface AuthBindings {
  readonly DB: D1Database;
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly SESSION_SECRET: string;
}

// Post-sign-in destinations a login link may request; anything else falls
// back to the default so `next` cannot become an open redirect.
const signInDestinations = new Map<string, string>([
  ["onboarding", "/onboarding"],
]);

const pendingInstallationId = (value: string | undefined) => {
  const installationId = Number(value);

  return Number.isInteger(installationId) && installationId > 0
    ? Option.some(installationId)
    : Option.none<number>();
};

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

/**
 * Sign-in failures for a person in a browser get a page with a way back
 * in; other clients keep the JSON error body.
 */
const signInError = (
  c: Context,
  status: 400 | 401 | 500,
  code: string,
  message: string,
  explanation: string,
) =>
  (c.req.header("accept") ?? "").includes("text/html")
    ? c.html(signInErrorPage(explanation), status)
    : c.json({ error: { code, message } }, status);

export const createAuthRoutes = (
  oauthLayer?: Layer.Layer<GitHubOAuth>,
  githubAppLayer?: Layer.Layer<GitHubAppAuth | GitHubInstallationClient>,
) => {
  const routes = new Hono<{ Bindings: AuthBindings }>();

  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");

    await next();
  });

  routes.get("/login", (c) => {
    const state = crypto.randomUUID();

    setCookie(c, OAUTH_STATE_COOKIE, state, {
      ...cookieOptions,
      maxAge: 600,
    });

    const next = c.req.query("next");

    if (next !== undefined && signInDestinations.has(next)) {
      setCookie(c, OAUTH_NEXT_COOKIE, next, { ...cookieOptions, maxAge: 600 });
    }

    return c.redirect(authorizeUrl(c.env.GITHUB_OAUTH_CLIENT_ID, state));
  });

  routes.get("/callback", async (c) => {
    const state = c.req.query("state");
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    const next = signInDestinations.get(getCookie(c, OAUTH_NEXT_COOKIE) ?? "");

    const pendingInstallation = pendingInstallationId(
      getCookie(c, PENDING_INSTALLATION_COOKIE),
    );

    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
    deleteCookie(c, OAUTH_NEXT_COOKIE, { path: "/" });
    deleteCookie(c, PENDING_INSTALLATION_COOKIE, { path: "/" });

    if (
      state === undefined ||
      expectedState === undefined ||
      state !== expectedState
    ) {
      return signInError(
        c,
        401,
        "invalid_oauth_state",
        "OAuth state mismatch",
        "The sign-in link expired or was opened in another tab. Start again from here.",
      );
    }

    if (c.req.query("error") !== undefined) {
      return signInError(
        c,
        401,
        "oauth_denied",
        "GitHub sign-in was not completed. Try signing in again.",
        "GitHub sign-in was cancelled. Fletcher needs it to show your repositories.",
      );
    }

    const code = c.req.query("code");

    if (code === undefined || code === "") {
      return signInError(
        c,
        400,
        "invalid_oauth_callback",
        "GitHub authorization code is missing",
        "GitHub didn't send a sign-in code. Start again from here.",
      );
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const oauth = yield* GitHubOAuth;
        const accessToken = yield* oauth.exchangeCode(code);
        const identity = yield* oauth.fetchUser(accessToken);
        const access = yield* oauth.fetchUserAccess(accessToken);
        const user = yield* UserRepository.upsert(identity);

        yield* syncUserInstallations(access.installations, pendingInstallation);

        yield* revokeSession(
          c.env.SESSION_SECRET,
          getCookie(c, SESSION_COOKIE),
        );

        const sessionCookie = yield* createSession(
          c.env.SESSION_SECRET,
          user.id,
          access.repositoryIds,
        );

        return {
          sessionCookie,
          destination:
            next ??
            (access.repositoryIds.length === 0 ? "/onboarding" : "/dashboard"),
        };
      }).pipe(
        Effect.provide(
          oauthLayer ??
            GitHubOAuthLive({
              clientId: c.env.GITHUB_OAUTH_CLIENT_ID,
              clientSecret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
            }),
        ),
        Effect.provide(
          githubAppLayer ??
            Layer.merge(
              GitHubAppAuthLive({
                appId: c.env.GITHUB_APP_ID,
                privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
              }),
              GitHubInstallationClientLive({}),
            ),
        ),
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.tapError((error) =>
          logError("oauth_sign_in_failed", { errorCode: error._tag }),
        ),
        Effect.match({
          onFailure: () =>
            signInError(
              c,
              500,
              "oauth_failed",
              "GitHub sign-in failed. Try signing in again.",
              "GitHub didn't answer as expected. Wait a minute, then sign in again.",
            ),
          onSuccess: ({ sessionCookie, destination }) => {
            setCookie(c, SESSION_COOKIE, sessionCookie, {
              ...cookieOptions,
              maxAge: SESSION_TTL_SECONDS,
            });

            return c.redirect(destination);
          },
        }),
      ),
    );
  });

  routes.get("/logout", (c) => {
    c.header("Allow", "POST");

    return c.json(
      {
        error: { code: "method_not_allowed", message: "Use POST to sign out" },
      },
      405,
    );
  });

  routes.post("/logout", async (c) => {
    if (c.req.header("origin") !== new URL(c.req.url).origin) {
      return c.json(
        {
          error: {
            code: "invalid_origin",
            message: "Same-origin request required",
          },
        },
        403,
      );
    }

    return Effect.runPromise(
      revokeSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE)).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.tapError((error) =>
          logError("session_logout_failed", { errorCode: error._tag }),
        ),
        Effect.match({
          onFailure: () =>
            c.json(
              {
                error: {
                  code: "logout_failed",
                  message: "Sign-out failed. Try again.",
                },
              },
              500,
            ),
          onSuccess: () => {
            deleteCookie(c, SESSION_COOKIE, { path: "/" });

            return c.redirect("/dashboard", 303);
          },
        }),
      ),
    );
  });

  return routes;
};

import { Effect } from "effect";
import type { Layer } from "effect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { makeLiveLayer, UserRepository } from "@not-quite-my-tempo/db";

import { logError } from "../logging.js";

import { authorizeUrl, GitHubOAuth, GitHubOAuthLive } from "./github-oauth.js";
import {
  createSession,
  OAUTH_STATE_COOKIE,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./session.js";

interface AuthBindings {
  readonly DB: D1Database;
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly SESSION_SECRET: string;
}

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

export const createAuthRoutes = (oauthLayer?: Layer.Layer<GitHubOAuth>) => {
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

    return c.redirect(authorizeUrl(c.env.GITHUB_OAUTH_CLIENT_ID, state));
  });

  routes.get("/callback", async (c) => {
    const state = c.req.query("state");
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);

    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

    if (
      state === undefined ||
      expectedState === undefined ||
      state !== expectedState
    ) {
      return c.json(
        {
          error: {
            code: "invalid_oauth_state",
            message: "OAuth state mismatch",
          },
        },
        401,
      );
    }

    if (c.req.query("error") !== undefined) {
      return c.json(
        {
          error: {
            code: "oauth_denied",
            message: "GitHub sign-in was not completed. Try signing in again.",
          },
        },
        401,
      );
    }

    const code = c.req.query("code");

    if (code === undefined || code === "") {
      return c.json(
        {
          error: {
            code: "invalid_oauth_callback",
            message: "GitHub authorization code is missing",
          },
        },
        400,
      );
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const oauth = yield* GitHubOAuth;
        const accessToken = yield* oauth.exchangeCode(code);
        const identity = yield* oauth.fetchUser(accessToken);
        const repositoryIds = yield* oauth.fetchUserRepositoryIds(accessToken);
        const user = yield* UserRepository.upsert(identity);

        yield* revokeSession(
          c.env.SESSION_SECRET,
          getCookie(c, SESSION_COOKIE),
        );

        return yield* createSession(
          c.env.SESSION_SECRET,
          user.id,
          repositoryIds,
        );
      }).pipe(
        Effect.provide(
          oauthLayer ??
            GitHubOAuthLive({
              clientId: c.env.GITHUB_OAUTH_CLIENT_ID,
              clientSecret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
            }),
        ),
        Effect.provide(makeLiveLayer(c.env.DB)),
        Effect.tapError((error) =>
          logError("oauth_sign_in_failed", { errorCode: error._tag }),
        ),
        Effect.match({
          onFailure: () =>
            c.json(
              {
                error: {
                  code: "oauth_failed",
                  message: "GitHub sign-in failed. Try signing in again.",
                },
              },
              500,
            ),
          onSuccess: (sessionCookie) => {
            setCookie(c, SESSION_COOKIE, sessionCookie, {
              ...cookieOptions,
              maxAge: SESSION_TTL_SECONDS,
            });

            return c.redirect("/dashboard");
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

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  authorizeUrl,
  GitHubOAuth,
  GitHubOAuthLive,
} from "../src/auth/github-oauth";
import type { GitHubOAuthService } from "../src/auth/github-oauth";

const withOAuth = <A, E>(
  fetchImpl: typeof fetch,
  use: (oauth: GitHubOAuthService) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const oauth = yield* GitHubOAuth;

    return yield* use(oauth);
  }).pipe(
    Effect.provide(
      GitHubOAuthLive({
        clientId: "client123",
        clientSecret: "secret456",
        baseUrl: "https://github.test",
        apiBaseUrl: "https://api.github.test",
        fetchImpl,
      }),
    ),
  );

describe("authorizeUrl", () => {
  it("builds the GitHub authorize URL with client id and state", () => {
    expect(authorizeUrl("client123", "state789")).toBe(
      "https://github.com/login/oauth/authorize?client_id=client123&state=state789",
    );
  });
});

describe("GitHubOAuth", () => {
  it("exchanges a code for an access token", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (url, init) => {
      requests.push({ url: String(url), init });

      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "gho_user" })),
      );
    };

    const token = await Effect.runPromise(
      withOAuth(fetchImpl, (oauth) => oauth.exchangeCode("code123")),
    );

    expect(token).toBe("gho_user");
    expect(requests[0]?.url).toBe(
      "https://github.test/login/oauth/access_token",
    );

    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body).toEqual({
      client_id: "client123",
      client_secret: "secret456",
      code: "code123",
    });
  });

  it("fetches the user's installation ids", async () => {
    const fetchImpl: typeof fetch = (url) =>
      Promise.resolve(
        String(url).endsWith("/user/installations")
          ? new Response(
              JSON.stringify({
                installations: [{ id: 1001 }, { id: 2002 }],
              }),
            )
          : new Response("unexpected", { status: 500 }),
      );

    const ids = await Effect.runPromise(
      withOAuth(fetchImpl, (oauth) =>
        oauth.fetchUserInstallationIds("gho_user"),
      ),
    );

    expect(ids).toEqual([1001, 2002]);
  });

  it("surfaces failed exchanges with status and body", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("bad_verification_code", { status: 401 }));

    const error = await Effect.runPromise(
      Effect.flip(withOAuth(fetchImpl, (oauth) => oauth.exchangeCode("nope"))),
    );

    expect(error._tag).toBe("OAuthResponseError");
    expect(error).toMatchObject({ status: 401 });
  });
});

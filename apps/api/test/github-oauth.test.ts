import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

import {
  authorizeUrl,
  GitHubOAuth,
  GitHubOAuthLive,
} from "../src/auth/github-oauth";
import type { GitHubOAuthService } from "../src/auth/github-oauth";

const installation = (id: number) => ({
  id,
  account: { id: id + 50_000, login: `org-${id}`, type: "Organization" },
});

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

  it("fetches the user's immutable id and current login", async () => {
    const fetchImpl: typeof fetch = (url) => {
      expect(String(url)).toBe("https://api.github.test/user");

      return Promise.resolve(
        new Response(JSON.stringify({ id: 123456, login: "octocat" })),
      );
    };

    const user = await Effect.runPromise(
      withOAuth(fetchImpl, (oauth) => oauth.fetchUser("gho_user")),
    );

    expect(user).toEqual({ githubUserId: 123456, login: "octocat" });
  });

  it("rejects a non-positive or non-integer GitHub user id", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 0, login: "octocat" })),
      );

    const error = await Effect.runPromise(
      Effect.flip(withOAuth(fetchImpl, (oauth) => oauth.fetchUser("gho_user"))),
    );

    expect(error._tag).toBe("OAuthRequestError");
    expect(JSON.stringify(error)).not.toContain('"id":0');
  });

  it("paginates installations and repositories, deduplicating repository ids", async () => {
    const pageSize = 100;

    const firstInstallationsPage = Array.from(
      { length: pageSize },
      (_, index) => installation(1000 + index),
    );

    const firstRepositoriesPage = Array.from(
      { length: pageSize },
      (_, index) => ({ id: 9000 + index }),
    );

    const requests: string[] = [];

    const fetchImpl: typeof fetch = (input) => {
      const url = new URL(String(input));
      requests.push(url.href);

      if (url.pathname === "/user/installations") {
        const page = url.searchParams.get("page");

        if (page === "1") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ installations: firstInstallationsPage }),
            ),
          );
        }

        if (page === "2") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                installations: [installation(2001), installation(2002)],
              }),
            ),
          );
        }
      }

      const installationMatch = url.pathname.match(
        /^\/user\/installations\/(\d+)\/repositories$/,
      );

      const installationId = installationMatch?.[1];

      if (installationId !== undefined) {
        const page = url.searchParams.get("page");

        if (installationId !== "2001" && installationId !== "2002") {
          return Promise.resolve(
            new Response(JSON.stringify({ repositories: [] })),
          );
        }

        if (installationId === "2001" && page === "1") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ repositories: firstRepositoriesPage }),
            ),
          );
        }

        if (installationId === "2001" && page === "2") {
          return Promise.resolve(
            new Response(JSON.stringify({ repositories: [{ id: 9100 }] })),
          );
        }

        if (installationId === "2002" && page === "1") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ repositories: [{ id: 9100 }, { id: 9200 }] }),
            ),
          );
        }
      }

      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };

    const access = await Effect.runPromise(
      withOAuth(fetchImpl, (oauth) => oauth.fetchUserAccess("gho_user")),
    );

    expect(access.installations).toHaveLength(102);
    expect(access.installations[101]).toEqual({
      installationId: 2002,
      accountId: 52_002,
      accountLogin: "org-2002",
      accountType: "Organization",
    });
    expect(access.repositoryIds).toEqual([
      ...firstRepositoriesPage.map(({ id }) => id),
      9100,
      9200,
    ]);

    const installationRequests = requests.filter((url) =>
      new URL(url).pathname.endsWith("/user/installations"),
    );

    expect(installationRequests).toEqual([
      "https://api.github.test/user/installations?per_page=100&page=1",
      "https://api.github.test/user/installations?per_page=100&page=2",
    ]);

    const repositoriesRequests = requests.filter((url) =>
      new URL(url).pathname.includes("/repositories"),
    );

    expect(repositoriesRequests).toContain(
      "https://api.github.test/user/installations/2001/repositories?per_page=100&page=1",
    );
    expect(repositoriesRequests).toContain(
      "https://api.github.test/user/installations/2001/repositories?per_page=100&page=2",
    );
    expect(repositoriesRequests).toContain(
      "https://api.github.test/user/installations/2002/repositories?per_page=100&page=1",
    );
  });

  it("does not return partial repository access when an installation is inaccessible", async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/user/installations") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              installations: [installation(1001), installation(2002)],
            }),
          ),
        );
      }

      if (url.pathname.endsWith("/1001/repositories")) {
        return Promise.resolve(
          new Response(JSON.stringify({ repositories: [{ id: 9001 }] })),
        );
      }

      if (url.pathname.endsWith("/2002/repositories")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ message: "repository access denied" }),
            { status: 403 },
          ),
        );
      }

      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };

    const error = await Effect.runPromise(
      Effect.flip(
        withOAuth(fetchImpl, (oauth) => oauth.fetchUserAccess("gho_user")),
      ),
    );

    expect(error._tag).toBe("OAuthResponseError");
    expect(error).toMatchObject({ status: 403 });
    expect(JSON.stringify(error)).not.toContain("repository access denied");
  });

  it("recognizes only active organization owners", async () => {
    const answer = (
      status: number,
      body: {
        readonly state?: string;
        readonly role?: string;
        readonly message?: string;
      },
    ) =>
      Effect.runPromise(
        Effect.either(
          withOAuth(
            () =>
              Promise.resolve(new Response(JSON.stringify(body), { status })),
            (oauth) => oauth.isOrgOwner("gho_user", "tempo-band"),
          ),
        ),
      );

    expect(await answer(200, { state: "active", role: "admin" })).toEqual(
      Either.right(true),
    );
    expect(await answer(200, { state: "active", role: "member" })).toEqual(
      Either.right(false),
    );
    expect(await answer(200, { state: "pending", role: "admin" })).toEqual(
      Either.right(false),
    );
    expect(await answer(403, { message: "Resource not accessible" })).toEqual(
      Either.right(false),
    );
    expect(await answer(404, { message: "Not Found" })).toEqual(
      Either.right(false),
    );
    expect(Either.isLeft(await answer(502, { message: "Bad gateway" }))).toBe(
      true,
    );
  });

  it("sanitizes a failed exchange response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "bad_verification_code",
            error_description: "secret response details",
            access_token: "gho_should_not_escape",
          }),
          { status: 200 },
        ),
      );

    const error = await Effect.runPromise(
      Effect.flip(withOAuth(fetchImpl, (oauth) => oauth.exchangeCode("nope"))),
    );

    expect(error._tag).toBe("OAuthResponseError");
    expect(error).toMatchObject({ status: 200 });
    expect(JSON.stringify(error)).not.toContain("secret response details");
    expect(JSON.stringify(error)).not.toContain("gho_should_not_escape");
    expect(JSON.stringify(error)).not.toContain("bad_verification_code");
  });

  it("sanitizes a non-2xx exchange response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "bad_verification_code",
            access_token: "gho_secret",
          }),
          { status: 401 },
        ),
      );

    const error = await Effect.runPromise(
      Effect.flip(withOAuth(fetchImpl, (oauth) => oauth.exchangeCode("nope"))),
    );

    expect(error._tag).toBe("OAuthResponseError");
    expect(error).toMatchObject({ status: 401 });
    expect(JSON.stringify(error)).not.toContain("gho_secret");
    expect(JSON.stringify(error)).not.toContain("bad_verification_code");
  });
});

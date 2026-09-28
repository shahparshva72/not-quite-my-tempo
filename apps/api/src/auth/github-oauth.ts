import { Context, Data, Effect, Layer, Schema } from "effect";

const GITHUB_BASE_URL = "https://github.com";

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

const USER_AGENT = "not-quite-my-tempo";

export class OAuthRequestError extends Data.TaggedError("OAuthRequestError")<{
  readonly message: string;
}> {}

export class OAuthResponseError extends Data.TaggedError("OAuthResponseError")<{
  readonly status: number;
}> {}

export type GitHubOAuthError = OAuthRequestError | OAuthResponseError;

const AccessTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  error: Schema.optional(Schema.NonEmptyString),
});

const GitHubId = Schema.Number.pipe(Schema.int(), Schema.positive());

const UserResponse = Schema.Struct({
  id: GitHubId,
  login: Schema.NonEmptyString,
});

const UserInstallationsResponse = Schema.Struct({
  installations: Schema.Array(
    Schema.Struct({
      id: GitHubId,
      account: Schema.Struct({
        id: GitHubId,
        login: Schema.NonEmptyString,
        type: Schema.NonEmptyString,
      }),
    }),
  ),
});

const OrgMembershipResponse = Schema.Struct({
  state: Schema.String,
  role: Schema.String,
});

const UserRepositoriesResponse = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ id: GitHubId })),
});

export interface GitHubUser {
  readonly githubUserId: number;
  readonly login: string;
}

export interface UserInstallation {
  readonly installationId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly accountType: string;
}

/**
 * What the signed-in user can reach through the GitHub App: the
 * installations visible to them and the union of their repositories.
 */
export interface UserAccess {
  readonly installations: readonly UserInstallation[];
  readonly repositoryIds: readonly number[];
}

export interface GitHubOAuthService {
  readonly exchangeCode: (
    code: string,
  ) => Effect.Effect<string, GitHubOAuthError>;
  readonly fetchUser: (
    accessToken: string,
  ) => Effect.Effect<GitHubUser, GitHubOAuthError>;
  readonly fetchUserAccess: (
    accessToken: string,
  ) => Effect.Effect<UserAccess, GitHubOAuthError>;
  /**
   * Whether the user is an active owner of the GitHub organization. Needs
   * the App's Organization "Members: Read" permission; when GitHub refuses
   * (403/404, e.g. the org hasn't approved it) the answer is false.
   */
  readonly isOrgOwner: (
    accessToken: string,
    org: string,
  ) => Effect.Effect<boolean, GitHubOAuthError>;
}

export class GitHubOAuth extends Context.Tag(
  "@not-quite-my-tempo/api/GitHubOAuth",
)<GitHubOAuth, GitHubOAuthService>() {}

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl?: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export const authorizeUrl = (clientId: string, state: string) =>
  `${GITHUB_BASE_URL}/login/oauth/authorize?client_id=${encodeURIComponent(
    clientId,
  )}&state=${encodeURIComponent(state)}`;

const oauthRequest = (
  config: GitHubOAuthConfig,
  url: string,
  init: RequestInit,
) =>
  Effect.gen(function* () {
    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, requestInit?: RequestInit) =>
        globalThis.fetch(input, requestInit));

    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(url, init),
      catch: () =>
        new OAuthRequestError({ message: "GitHub OAuth request failed" }),
    });

    if (!response.ok) {
      return yield* new OAuthResponseError({ status: response.status });
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new OAuthRequestError({
          message: "GitHub OAuth response could not be read",
        }),
    });

    return { body, status: response.status };
  });

const decodeBody = <A, I>(schema: Schema.Schema<A, I>, body: string) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(body).pipe(
    Effect.mapError(
      () =>
        new OAuthRequestError({ message: "GitHub OAuth response was invalid" }),
    ),
  );

const PAGE_SIZE = 100;

export const GitHubOAuthLive = (config: GitHubOAuthConfig) => {
  const baseUrl = config.baseUrl ?? GITHUB_BASE_URL;
  const apiBaseUrl = config.apiBaseUrl ?? GITHUB_API_BASE_URL;

  const apiHeaders = (accessToken: string) => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  });

  return Layer.succeed(
    GitHubOAuth,
    GitHubOAuth.of({
      exchangeCode: (code) =>
        Effect.gen(function* () {
          const body = yield* oauthRequest(
            config,
            `${baseUrl}/login/oauth/access_token`,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "user-agent": USER_AGENT,
              },
              body: JSON.stringify({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code,
              }),
            },
          );

          const decoded = yield* decodeBody(
            AccessTokenResponse,
            body.body,
          ).pipe(
            Effect.mapError(
              () => new OAuthResponseError({ status: body.status }),
            ),
          );

          if (decoded.error !== undefined) {
            return yield* new OAuthResponseError({ status: body.status });
          }

          return decoded.access_token;
        }),
      fetchUser: (accessToken) =>
        Effect.gen(function* () {
          const response = yield* oauthRequest(config, `${apiBaseUrl}/user`, {
            method: "GET",
            headers: apiHeaders(accessToken),
          });

          const decoded = yield* decodeBody(UserResponse, response.body);

          return {
            githubUserId: decoded.id,
            login: decoded.login,
          };
        }),
      isOrgOwner: (accessToken, org) =>
        oauthRequest(
          config,
          `${apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(org)}`,
          { method: "GET", headers: apiHeaders(accessToken) },
        ).pipe(
          Effect.flatMap((response) =>
            decodeBody(OrgMembershipResponse, response.body),
          ),
          Effect.map(
            (membership) =>
              membership.state === "active" && membership.role === "admin",
          ),
          Effect.catchTag("OAuthResponseError", (error) =>
            error.status === 403 || error.status === 404
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        ),
      fetchUserAccess: (accessToken) =>
        Effect.gen(function* () {
          const userInstallations: UserInstallation[] = [];
          const repositoryIds = new Set<number>();
          let installationPage = 1;

          while (true) {
            const installationsResponse = yield* oauthRequest(
              config,
              `${apiBaseUrl}/user/installations?per_page=${PAGE_SIZE}&page=${installationPage}`,
              {
                method: "GET",
                headers: apiHeaders(accessToken),
              },
            );

            const installations = yield* decodeBody(
              UserInstallationsResponse,
              installationsResponse.body,
            );

            for (const installation of installations.installations) {
              userInstallations.push({
                installationId: installation.id,
                accountId: installation.account.id,
                accountLogin: installation.account.login,
                accountType: installation.account.type,
              });

              let repositoryPage = 1;

              while (true) {
                const repositoriesResponse = yield* oauthRequest(
                  config,
                  `${apiBaseUrl}/user/installations/${installation.id}/repositories?per_page=${PAGE_SIZE}&page=${repositoryPage}`,
                  {
                    method: "GET",
                    headers: apiHeaders(accessToken),
                  },
                );

                const repositories = yield* decodeBody(
                  UserRepositoriesResponse,
                  repositoriesResponse.body,
                );

                for (const repository of repositories.repositories) {
                  repositoryIds.add(repository.id);
                }

                if (repositories.repositories.length < PAGE_SIZE) {
                  break;
                }

                repositoryPage += 1;
              }
            }

            if (installations.installations.length < PAGE_SIZE) {
              break;
            }

            installationPage += 1;
          }

          return {
            installations: userInstallations,
            repositoryIds: [...repositoryIds],
          };
        }),
    }),
  );
};

import { Context, Data, Effect, Layer, Schema } from "effect";

const GITHUB_BASE_URL = "https://github.com";

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

const USER_AGENT = "not-quite-my-tempo";

export class OAuthRequestError extends Data.TaggedError("OAuthRequestError")<{
  readonly cause: unknown;
}> {}

export class OAuthResponseError extends Data.TaggedError("OAuthResponseError")<{
  readonly status: number;
  readonly body: string;
}> {}

export type GitHubOAuthError = OAuthRequestError | OAuthResponseError;

const AccessTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
});

const UserResponse = Schema.Struct({ login: Schema.NonEmptyString });

const UserInstallationsResponse = Schema.Struct({
  installations: Schema.Array(Schema.Struct({ id: Schema.Number })),
});

export interface GitHubOAuthService {
  readonly exchangeCode: (
    code: string,
  ) => Effect.Effect<string, GitHubOAuthError>;
  readonly fetchUserLogin: (
    accessToken: string,
  ) => Effect.Effect<string, GitHubOAuthError>;
  readonly fetchUserInstallationIds: (
    accessToken: string,
  ) => Effect.Effect<readonly number[], GitHubOAuthError>;
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
      catch: (cause) => new OAuthRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new OAuthRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new OAuthResponseError({
        status: response.status,
        body,
      });
    }

    return body;
  });

const decodeBody = <A, I>(schema: Schema.Schema<A, I>, body: string) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(body).pipe(
    Effect.mapError((cause) => new OAuthRequestError({ cause })),
  );

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

          const decoded = yield* decodeBody(AccessTokenResponse, body);

          return decoded.access_token;
        }),
      fetchUserLogin: (accessToken) =>
        Effect.gen(function* () {
          const body = yield* oauthRequest(config, `${apiBaseUrl}/user`, {
            method: "GET",
            headers: apiHeaders(accessToken),
          });

          const decoded = yield* decodeBody(UserResponse, body);

          return decoded.login;
        }),
      fetchUserInstallationIds: (accessToken) =>
        Effect.gen(function* () {
          const body = yield* oauthRequest(
            config,
            `${apiBaseUrl}/user/installations`,
            {
              method: "GET",
              headers: apiHeaders(accessToken),
            },
          );

          const decoded = yield* decodeBody(UserInstallationsResponse, body);

          return decoded.installations.map((installation) => installation.id);
        }),
    }),
  );
};

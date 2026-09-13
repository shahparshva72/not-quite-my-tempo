import { Clock, Context, Data, Effect, Layer, Schema } from "effect";

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

const USER_AGENT = "not-quite-my-tempo";

// GitHub recommends backdating iat by 60 seconds to absorb clock drift and
// caps JWT lifetime at 10 minutes; 9 minutes leaves a safety margin.
const JWT_ISSUED_AT_SKEW_SECONDS = 60;

const JWT_LIFETIME_SECONDS = 540;

export class GitHubAppJwtError extends Data.TaggedError("GitHubAppJwtError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GitHubApiRequestError extends Data.TaggedError(
  "GitHubApiRequestError",
)<{
  readonly cause: unknown;
}> {}

export class GitHubInstallationTokenError extends Data.TaggedError(
  "GitHubInstallationTokenError",
)<{
  readonly status: number;
  readonly body: string;
}> {}

export type GitHubAppAuthError =
  | GitHubAppJwtError
  | GitHubApiRequestError
  | GitHubInstallationTokenError;

const InstallationTokenResponse = Schema.Struct({
  token: Schema.NonEmptyString,
  expires_at: Schema.Date,
});

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GitHubAppAuthService {
  readonly mintInstallationToken: (
    installationId: number,
  ) => Effect.Effect<InstallationToken, GitHubAppAuthError>;
}

export class GitHubAppAuth extends Context.Tag(
  "@not-quite-my-tempo/api/GitHubAppAuth",
)<GitHubAppAuth, GitHubAppAuthService>() {}

export interface GitHubAppAuthConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const textEncoder = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array) => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

interface JwtHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
}

interface JwtClaims {
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
}

const base64UrlEncodeJson = (value: JwtHeader | JwtClaims) =>
  base64UrlEncode(textEncoder.encode(JSON.stringify(value)));

const decodePkcs8Pem = (pem: string) =>
  Effect.gen(function* () {
    if (pem.includes("RSA PRIVATE KEY")) {
      return yield* new GitHubAppJwtError({
        message:
          "GITHUB_APP_PRIVATE_KEY is a PKCS#1 PEM; convert it to PKCS#8 " +
          "with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt " +
          "-in app.pem -out app.pkcs8.pem",
      });
    }

    return yield* Effect.try({
      try: () => {
        const base64 = pem
          .replace("-----BEGIN PRIVATE KEY-----", "")
          .replace("-----END PRIVATE KEY-----", "")
          .replaceAll(/\s/g, "");

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        return bytes;
      },
      catch: (cause) =>
        new GitHubAppJwtError({
          message: "GITHUB_APP_PRIVATE_KEY is not a valid PEM",
          cause,
        }),
    });
  });

export const createAppJwt = (appId: string, privateKeyPem: string) =>
  Effect.gen(function* () {
    const keyBytes = yield* decodePkcs8Pem(privateKeyPem);

    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "pkcs8",
          keyBytes,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: (cause) =>
        new GitHubAppJwtError({
          message: "Failed to import the GitHub App private key",
          cause,
        }),
    });

    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    const signingInput = [
      base64UrlEncodeJson({ alg: "RS256", typ: "JWT" }),
      base64UrlEncodeJson({
        iat: nowSeconds - JWT_ISSUED_AT_SKEW_SECONDS,
        exp: nowSeconds + JWT_LIFETIME_SECONDS,
        iss: appId,
      }),
    ].join(".");

    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key,
          textEncoder.encode(signingInput),
        ),
      catch: (cause) =>
        new GitHubAppJwtError({
          message: "Failed to sign the GitHub App JWT",
          cause,
        }),
    });

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  });

const mintInstallationToken = (
  config: GitHubAppAuthConfig,
  installationId: number,
) =>
  Effect.gen(function* () {
    const jwt = yield* createAppJwt(config.appId, config.privateKey);

    const baseUrl = config.baseUrl ?? GITHUB_API_BASE_URL;

    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `${baseUrl}/app/installations/${installationId}/access_tokens`,
          {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${jwt}`,
              "user-agent": USER_AGENT,
              "x-github-api-version": GITHUB_API_VERSION,
            },
          },
        ),
      catch: (cause) => new GitHubApiRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new GitHubApiRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new GitHubInstallationTokenError({
        status: response.status,
        body,
      });
    }

    const decoded = yield* Schema.decodeUnknown(
      Schema.parseJson(InstallationTokenResponse),
    )(body).pipe(
      Effect.mapError((cause) => new GitHubApiRequestError({ cause })),
    );

    return { token: decoded.token, expiresAt: decoded.expires_at };
  });

export const GitHubAppAuthLive = (config: GitHubAppAuthConfig) =>
  Layer.succeed(
    GitHubAppAuth,
    GitHubAppAuth.of({
      mintInstallationToken: (installationId) =>
        mintInstallationToken(config, installationId),
    }),
  );

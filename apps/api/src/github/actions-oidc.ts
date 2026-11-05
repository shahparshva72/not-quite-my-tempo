import {
  Array as Arr,
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

/**
 * Verifies the OIDC tokens GitHub Actions mints for a job
 * (`id-token: write`). A valid token proves the request comes from a
 * workflow run in the repository its claims name, so a runner needs no
 * Fletcher secret to claim or report a review.
 */

export const GITHUB_ACTIONS_ISSUER =
  "https://token.actions.githubusercontent.com";

const DEFAULT_JWKS_URL = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;

// Tokens live about five minutes; allow a little drift either way.
const CLOCK_SKEW_SECONDS = 60;

// GitHub rotates keys rarely; an unknown kid refetches sooner.
const JWKS_CACHE_MILLIS = 10 * 60 * 1000;

export type ActionsOidcFailure =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "jwks_unavailable";

export class ActionsOidcError extends Data.TaggedError("ActionsOidcError")<{
  readonly reason: ActionsOidcFailure;
}> {}

// JWT allows one audience or several.
const Audiences = Schema.transform(
  Schema.Union(Schema.String, Schema.Array(Schema.String)),
  Schema.Array(Schema.String),
  { strict: true, decode: (aud) => Arr.ensure(aud), encode: (aud) => aud },
);

/** The claims Fletcher relies on. GitHub sends numeric IDs as strings. */
export const ActionsOidcClaims = Schema.Struct({
  iss: Schema.String,
  aud: Audiences,
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  repository: Schema.String,
  repository_id: Schema.String,
  repository_owner_id: Schema.String,
  event_name: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  run_id: Schema.String,
  run_attempt: Schema.String,
  job_workflow_ref: Schema.String,
});

export type ActionsOidcClaims = typeof ActionsOidcClaims.Type;

const JwtHeader = Schema.Struct({
  alg: Schema.String,
  kid: Schema.String,
});

const Jwk = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
});

type Jwk = typeof Jwk.Type;

const Jwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });

export interface GitHubActionsOidcService {
  readonly verify: (
    token: string,
  ) => Effect.Effect<ActionsOidcClaims, ActionsOidcError>;
}

export class GitHubActionsOidc extends Context.Tag(
  "@not-quite-my-tempo/api/GitHubActionsOidc",
)<GitHubActionsOidc, GitHubActionsOidcService>() {}

export interface GitHubActionsOidcConfig {
  /** The `aud` runners request, e.g. `fletcher`. */
  readonly audience: string;
  readonly jwksUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const fail = (reason: ActionsOidcFailure) => new ActionsOidcError({ reason });

const base64UrlBytes = (segment: string) =>
  Effect.try({
    try: () => {
      const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
      const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    },
    catch: () => fail("malformed"),
  });

const decodeSegment = <A, I>(schema: Schema.Schema<A, I>, segment: string) =>
  base64UrlBytes(segment).pipe(
    Effect.flatMap((bytes) =>
      Schema.decodeUnknown(Schema.parseJson(schema))(
        new TextDecoder().decode(bytes),
      ),
    ),
    Effect.mapError(() => fail("malformed")),
  );

interface CachedKeys {
  readonly keys: ReadonlyMap<string, Jwk>;
  readonly fetchedAt: number;
}

// Per isolate: each Worker instance fetches GitHub's keys once in a while.
const jwksCache = new Map<string, CachedKeys>();

export const GitHubActionsOidcLive = (config: GitHubActionsOidcConfig) => {
  const jwksUrl = config.jwksUrl ?? DEFAULT_JWKS_URL;
  const fetchImpl = config.fetchImpl ?? fetch;

  const fetchKeys = (now: number) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(jwksUrl, {
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`JWKS request failed with ${response.status}`);
        }

        return response.json();
      },
      catch: () => fail("jwks_unavailable"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Jwks)),
      Effect.mapError(() => fail("jwks_unavailable")),
      Effect.map((jwks) => {
        const keys = new Map(
          jwks.keys.flatMap((key) =>
            Option.match(Schema.decodeUnknownOption(Jwk)(key), {
              onNone: () => [],
              onSome: (jwk): [string, Jwk][] => [[jwk.kid, jwk]],
            }),
          ),
        );

        jwksCache.set(jwksUrl, { keys, fetchedAt: now });

        return keys;
      }),
    );

  const keyFor = (kid: string, now: number) => {
    const cached = jwksCache.get(jwksUrl);

    const known =
      cached !== undefined && now - cached.fetchedAt < JWKS_CACHE_MILLIS
        ? cached.keys.get(kid)
        : undefined;

    return known === undefined
      ? fetchKeys(now).pipe(
          Effect.flatMap((keys) =>
            Option.match(Option.fromNullable(keys.get(kid)), {
              onNone: () => Effect.fail(fail("unknown_key")),
              onSome: Effect.succeed,
            }),
          ),
        )
      : Effect.succeed(known);
  };

  const verifySignature = (jwk: Jwk, signingInput: string, signature: string) =>
    base64UrlBytes(signature).pipe(
      Effect.flatMap((signatureBytes) =>
        Effect.tryPromise({
          try: async () => {
            const key = await crypto.subtle.importKey(
              "jwk",
              { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            );

            return crypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              key,
              signatureBytes,
              new TextEncoder().encode(signingInput),
            );
          },
          catch: () => fail("bad_signature"),
        }),
      ),
      Effect.filterOrFail(
        (valid) => valid,
        () => fail("bad_signature"),
      ),
    );

  const checkClaims = (claims: ActionsOidcClaims, nowSeconds: number) => {
    if (claims.iss !== GITHUB_ACTIONS_ISSUER) {
      return Effect.fail(fail("wrong_issuer"));
    }

    if (!claims.aud.includes(config.audience)) {
      return Effect.fail(fail("wrong_audience"));
    }

    if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      return Effect.fail(fail("expired"));
    }

    if (
      claims.nbf !== undefined &&
      claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds
    ) {
      return Effect.fail(fail("not_yet_valid"));
    }

    return Effect.succeed(claims);
  };

  return Layer.succeed(
    GitHubActionsOidc,
    GitHubActionsOidc.of({
      verify: (token) =>
        Effect.gen(function* () {
          const [header, payload, signature, ...rest] = token.split(".");

          if (
            header === undefined ||
            payload === undefined ||
            signature === undefined ||
            rest.length > 0
          ) {
            return yield* fail("malformed");
          }

          const decodedHeader = yield* decodeSegment(JwtHeader, header);

          if (decodedHeader.alg !== "RS256") {
            return yield* fail("unsupported_algorithm");
          }

          const now = yield* Clock.currentTimeMillis;
          const jwk = yield* keyFor(decodedHeader.kid, now);

          yield* verifySignature(jwk, `${header}.${payload}`, signature);

          const claims = yield* decodeSegment(ActionsOidcClaims, payload);

          return yield* checkClaims(claims, Math.floor(now / 1000));
        }),
    }),
  );
};

/** The bearer token of an Authorization header, if it has one. */
export const bearerToken = (authorization: string | undefined) =>
  Option.fromNullable(authorization).pipe(
    Option.flatMap((value) => {
      const match = /^Bearer\s+(\S+)$/i.exec(value);

      return Option.fromNullable(match?.[1]);
    }),
  );

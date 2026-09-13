import { Clock, Data, Effect, Option, Schema } from "effect";

export const SESSION_COOKIE = "nqmt_session";

export const OAUTH_STATE_COOKIE = "nqmt_oauth_state";

const SESSION_TTL_MILLIS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_TTL_SECONDS = SESSION_TTL_MILLIS / 1000;

const SessionPayload = Schema.Struct({
  login: Schema.NonEmptyString,
  installationIds: Schema.Array(Schema.Number),
  expiresAt: Schema.Number,
});

export type SessionPayload = typeof SessionPayload.Type;

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly cause: unknown;
}> {}

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

const base64UrlDecode = (segment: string) => {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        [usage],
      ),
    catch: (cause) => new SessionError({ cause }),
  });

/**
 * Creates a signed session cookie value:
 * `base64url(payload).base64url(hmac-sha256(payload))`.
 */
export const createSession = (
  secret: string,
  login: string,
  installationIds: readonly number[],
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const payload: SessionPayload = {
      login,
      installationIds,
      expiresAt: now + SESSION_TTL_MILLIS,
    };

    const encodedPayload = base64UrlEncode(
      textEncoder.encode(JSON.stringify(payload)),
    );

    const key = yield* hmacKey(secret, "sign");

    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign("HMAC", key, textEncoder.encode(encodedPayload)),
      catch: (cause) => new SessionError({ cause }),
    });

    return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
  });

/**
 * Verifies a session cookie value. Any failure — malformed value, bad
 * signature, expired payload, or a missing secret — resolves to `None`; the
 * caller treats that as "not signed in".
 */
export const verifySession = (
  secret: string | undefined,
  cookieValue: string | undefined,
): Effect.Effect<Option.Option<SessionPayload>> =>
  Effect.gen(function* () {
    if (
      secret === undefined ||
      secret === "" ||
      cookieValue === undefined ||
      !cookieValue.includes(".")
    ) {
      return Option.none<SessionPayload>();
    }

    const separator = cookieValue.indexOf(".");
    const encodedPayload = cookieValue.slice(0, separator);
    const encodedSignature = cookieValue.slice(separator + 1);

    const key = yield* hmacKey(secret, "verify");

    const valid = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify(
          "HMAC",
          key,
          base64UrlDecode(encodedSignature),
          textEncoder.encode(encodedPayload),
        ),
      catch: (cause) => new SessionError({ cause }),
    });

    if (!valid) {
      return Option.none<SessionPayload>();
    }

    const payload = yield* Schema.decodeUnknown(
      Schema.parseJson(SessionPayload),
    )(new TextDecoder().decode(base64UrlDecode(encodedPayload))).pipe(
      Effect.option,
    );

    const now = yield* Clock.currentTimeMillis;

    return Option.filter(payload, (session) => session.expiresAt > now);
  }).pipe(Effect.catchAll(() => Effect.succeed(Option.none<SessionPayload>())));

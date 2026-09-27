import { SessionRepository } from "@not-quite-my-tempo/db";
import type { DatabaseError } from "@not-quite-my-tempo/db";
import { Clock, Data, Effect, Option } from "effect";

export const SESSION_COOKIE = "nqmt_session";

export const OAUTH_STATE_COOKIE = "nqmt_oauth_state";

export const OAUTH_NEXT_COOKIE = "nqmt_oauth_next";

// Installation ID from GitHub's post-install redirect, held until the next
// sign-in verifies it against the user's own installations.
export const PENDING_INSTALLATION_COOKIE = "nqmt_pending_installation";

const SESSION_TTL_MILLIS = 60 * 60 * 1000;

export const SESSION_TTL_SECONDS = SESSION_TTL_MILLIS / 1000;

const SESSION_TOKEN_BYTES = 32;

const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface SessionPayload {
  readonly userId: number;
  readonly githubUserId: number;
  readonly login: string;
  readonly repositoryIds: readonly number[];
  readonly expiresAt: Date;
}

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly cause: unknown;
}> {}

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const createToken = () => {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);

  return bytesToHex(bytes);
};

const hmacKey = (secret: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: (cause) => new SessionError({ cause }),
  });

const tokenHash = (secret: string, token: string) =>
  Effect.gen(function* () {
    const key = yield* hmacKey(secret);

    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, textEncoder.encode(token)),
      catch: (cause) => new SessionError({ cause }),
    });

    return bytesToHex(new Uint8Array(digest));
  });

const isSessionToken = (value: string): boolean =>
  SESSION_TOKEN_PATTERN.test(value);

export const createSession = (
  secret: string,
  userId: number,
  repositoryIds: readonly number[],
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const token = createToken();
    const sessionRepository = yield* SessionRepository;

    yield* sessionRepository.create({
      tokenHash: yield* tokenHash(secret, token),
      userId,
      repositoryIds,
      expiresAt: new Date(now + SESSION_TTL_MILLIS),
    });

    return token;
  });

export const verifySession = (
  secret: string | undefined,
  cookieValue: string | undefined,
): Effect.Effect<
  Option.Option<SessionPayload>,
  SessionError | DatabaseError,
  SessionRepository
> =>
  Effect.gen(function* () {
    if (
      secret === undefined ||
      secret === "" ||
      cookieValue === undefined ||
      !isSessionToken(cookieValue)
    ) {
      return Option.none<SessionPayload>();
    }

    const sessionRepository = yield* SessionRepository;

    const session = yield* sessionRepository.findByTokenHash(
      yield* tokenHash(secret, cookieValue),
    );

    if (Option.isNone(session)) {
      return Option.none<SessionPayload>();
    }

    const now = yield* Clock.currentTimeMillis;

    if (session.value.expiresAt.getTime() <= now) {
      return Option.none<SessionPayload>();
    }

    return Option.some({
      userId: session.value.userId,
      githubUserId: session.value.githubUserId,
      login: session.value.login,
      repositoryIds: session.value.repositoryIds,
      expiresAt: session.value.expiresAt,
    });
  });

export const revokeSession = (
  secret: string,
  cookieValue: string | undefined,
): Effect.Effect<void, SessionError | DatabaseError, SessionRepository> =>
  Effect.gen(function* () {
    if (cookieValue === undefined || !isSessionToken(cookieValue)) {
      return;
    }

    const sessionRepository = yield* SessionRepository;

    yield* sessionRepository.revoke(yield* tokenHash(secret, cookieValue));
  });

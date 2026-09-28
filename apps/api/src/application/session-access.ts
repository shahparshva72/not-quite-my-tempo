import { Clock, Effect, Option } from "effect";
import { SessionRepository } from "@not-quite-my-tempo/db";

import type { SessionPayload } from "../auth/session.js";
import { decryptToken, tokenContext } from "../auth/token-cipher.js";
import { logError, logInfo } from "../logging.js";
import { refreshUserAccess } from "./user-access.js";

/** How long verified GitHub access is trusted before it is re-read. */
export const ACCESS_REFRESH_INTERVAL_MILLIS = 10 * 60 * 1000;

/**
 * Re-reads the session user's GitHub access when it is older than the
 * refresh interval, updating memberships and the session's repository IDs.
 *
 * - GitHub says the token is revoked (401): the session is revoked and the
 *   request is treated as signed out.
 * - Any other failure: the last verified access stays in place. Sessions
 *   expire after an hour, which caps how stale it can get.
 * - Sessions without a stored token (created before refresh existed) are
 *   left alone until they expire.
 */
export const refreshSessionAccess = (
  session: SessionPayload,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (
      session.githubTokenCiphertext === null ||
      (session.accessVerifiedAt !== null &&
        now - session.accessVerifiedAt.getTime() <
          ACCESS_REFRESH_INTERVAL_MILLIS)
    ) {
      return Option.some(session);
    }

    const verifiedAt = new Date(now);

    const refreshed = decryptToken(
      encryptionKey,
      session.githubTokenCiphertext,
      tokenContext(session.userId),
    ).pipe(
      Effect.flatMap((accessToken) =>
        refreshUserAccess(
          { id: session.userId, githubUserId: session.githubUserId },
          accessToken,
        ),
      ),
      Effect.tap((access) =>
        SessionRepository.updateAccess(
          session.tokenHash,
          access.repositoryIds,
          verifiedAt,
        ),
      ),
      Effect.map((access) =>
        Option.some<SessionPayload>({
          ...session,
          repositoryIds: access.repositoryIds,
          accessVerifiedAt: verifiedAt,
        }),
      ),
    );

    return yield* refreshed.pipe(
      Effect.catchTag("OAuthResponseError", (error) =>
        Effect.gen(function* () {
          if (error.status !== 401) {
            return yield* error;
          }

          yield* SessionRepository.revoke(session.tokenHash);
          yield* logInfo("access_revoked", {
            userId: session.userId,
            source: "token_revoked",
          });

          return Option.none<SessionPayload>();
        }),
      ),
      Effect.catchAll((error) =>
        logError("membership_refresh_failed", {
          userId: session.userId,
          errorCode: error._tag,
        }).pipe(Effect.as(Option.some(session))),
      ),
    );
  });

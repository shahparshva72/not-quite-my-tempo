import { Clock, Effect, Match, Option } from "effect";
import {
  MembershipRepository,
  SessionRepository,
  UserRepository,
} from "@not-quite-my-tempo/db";

import type { AccessRevocation } from "../github/access-event.js";
import { logInfo } from "../logging.js";

/**
 * Applies a revocation webhook immediately rather than waiting for the next
 * access refresh. Unknown users are a no-op: they never signed in, so there
 * is nothing to revoke.
 */
export const handleAccessRevocation = (revocation: AccessRevocation) =>
  Effect.gen(function* () {
    const user = yield* UserRepository.findByGithubUserId(
      revocation.githubUserId,
    );

    if (Option.isNone(user)) {
      return { status: "ignored" as const };
    }

    const userId = user.value.id;
    const now = new Date(yield* Clock.currentTimeMillis);

    yield* Match.value(revocation).pipe(
      Match.when({ kind: "app_revoked" }, () =>
        MembershipRepository.removeAllForUser(userId),
      ),
      Match.when({ kind: "org_member_removed" }, (removal) =>
        MembershipRepository.removeForAccount(
          userId,
          removal.githubAccountId,
          now,
        ),
      ),
      Match.exhaustive,
    );

    // Sessions carry repository IDs from every workspace, so end them all;
    // the next sign-in rebuilds access from GitHub.
    yield* SessionRepository.revokeAllForUser(userId);

    yield* logInfo("access_revoked", {
      userId,
      source:
        revocation.kind === "app_revoked"
          ? "webhook_app_revoked"
          : "webhook_member_removed",
    });

    return { status: "revoked" as const };
  });

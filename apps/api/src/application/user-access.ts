import { Clock, Effect, Option } from "effect";
import {
  GitHubInstallationRepository,
  MembershipRepository,
} from "@not-quite-my-tempo/db";
import type { VerifiedMembership } from "@not-quite-my-tempo/db";

import { GitHubOAuth } from "../auth/github-oauth.js";
import type { UserInstallation } from "../auth/github-oauth.js";
import { logError, logInfo } from "../logging.js";
import { syncUserInstallations } from "./installation-sync.js";

export interface AccessUser {
  readonly id: number;
  readonly githubUserId: number;
}

export interface UserAccessAnswer {
  readonly repositoryIds: readonly number[];
  readonly memberships: readonly VerifiedMembership[];
}

/**
 * Owner of a personal account is its holder; of an organization, an active
 * GitHub org owner. A failed org check counts as "not an owner" so sign-in
 * never depends on it; owner-only actions simply wait for the next refresh.
 */
const isOwner = (
  accessToken: string,
  githubUserId: number,
  installation: UserInstallation,
) =>
  installation.accountType === "User"
    ? Effect.succeed(installation.accountId === githubUserId)
    : Effect.flatMap(GitHubOAuth, (oauth) =>
        oauth.isOrgOwner(accessToken, installation.accountLogin),
      ).pipe(
        Effect.catchAll((error) =>
          logError("membership_owner_check_failed", {
            installationId: installation.installationId,
            errorCode: error._tag,
          }).pipe(Effect.as(false)),
        ),
      );

/**
 * Reads what the user can reach on GitHub: their repository IDs and, per
 * workspace, whether they own it. Writes nothing about the user, so a
 * GitHub failure during sign-in leaves no account behind.
 */
export const readUserAccess = (
  githubUserId: number,
  accessToken: string,
  pendingInstallationId: Option.Option<number>,
) =>
  Effect.gen(function* () {
    const oauth = yield* GitHubOAuth;
    const access = yield* oauth.fetchUserAccess(accessToken);

    yield* syncUserInstallations(access.installations, pendingInstallationId);

    const stored =
      yield* GitHubInstallationRepository.listByGithubInstallationIds(
        access.installations.map((installation) => installation.installationId),
      );

    const memberships: VerifiedMembership[] = [];

    for (const installation of access.installations) {
      const workspaceId = stored.find(
        (row) => row.githubInstallationId === installation.installationId,
      )?.workspaceId;

      // An installation whose sync failed has no workspace yet; the next
      // refresh picks it up.
      if (
        workspaceId === undefined ||
        workspaceId === null ||
        memberships.some((entry) => entry.workspaceId === workspaceId)
      ) {
        continue;
      }

      memberships.push({
        workspaceId,
        githubOwner: yield* isOwner(accessToken, githubUserId, installation),
      });
    }

    const answer: UserAccessAnswer = {
      repositoryIds: access.repositoryIds,
      memberships,
    };

    return answer;
  });

/** Makes the user's stored memberships match GitHub's answer. */
export const saveUserAccess = (userId: number, answer: UserAccessAnswer) =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);

    yield* MembershipRepository.syncForUser(userId, answer.memberships, now);

    yield* logInfo("membership_refreshed", {
      userId,
      workspaceCount: answer.memberships.length,
      ownerCount: answer.memberships.filter((entry) => entry.githubOwner)
        .length,
      repositoryCount: answer.repositoryIds.length,
    });
  });

/**
 * Re-reads and saves an existing user's access. Used by the periodic
 * refresh (docs/WORKSPACES_DESIGN.md); sign-in calls the two halves around
 * creating the user.
 */
export const refreshUserAccess = (user: AccessUser, accessToken: string) =>
  readUserAccess(user.githubUserId, accessToken, Option.none()).pipe(
    Effect.tap((answer) => saveUserAccess(user.id, answer)),
  );

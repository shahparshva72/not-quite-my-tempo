import { Data, Effect, Option } from "effect";
import {
  GitHubInstallationRepository,
  MembershipRepository,
  UserRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";

import { GitHubOAuth } from "../auth/github-oauth.js";
import type { SessionPayload } from "../auth/session.js";
import { decryptToken, tokenContext } from "../auth/token-cipher.js";
import { GitHubAppInstallations } from "../github/app-auth.js";
import { logError, logInfo } from "../logging.js";
import { authorizeWorkspace } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";
import { ensureNoRenewingSubscription } from "./billing.js";

/** The name typed to confirm a deletion isn't the one the form asked for. */
export class ConfirmationMismatchError extends Data.TaggedError(
  "ConfirmationMismatchError",
) {}

// GitHub names are case-insensitive, so the confirmation is too.
const confirms = (typed: string, expected: string) =>
  typed.trim().toLowerCase() === expected.toLowerCase();

/** The workspaces the account page lists, with the user's role in each. */
export const accountWorkspaces = (access: SessionAccess) =>
  MembershipRepository.listForUser(access.userId);

/**
 * Deletes the signed-in user's account: the user, their sessions, and their
 * memberships (docs/ACCOUNT_DELETION.md). Workspaces and their reviews stay;
 * they belong to the GitHub account, and an owner deletes them separately.
 * Then revokes Fletcher's authorization on GitHub, as a best effort: the
 * account is already gone, and people can also revoke it on GitHub.
 */
export const deleteAccount = (
  session: SessionPayload,
  confirmation: string,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    if (!confirms(confirmation, session.login)) {
      return yield* new ConfirmationMismatchError();
    }

    // Decrypted before the session that holds it is deleted.
    const githubToken =
      session.githubTokenCiphertext === null
        ? Option.none<string>()
        : yield* decryptToken(
            encryptionKey,
            session.githubTokenCiphertext,
            tokenContext(session.userId),
          ).pipe(Effect.option);

    yield* UserRepository.deleteById(session.userId);

    yield* logInfo("account_deleted", { userId: session.userId });

    if (Option.isNone(githubToken)) {
      return;
    }

    const oauth = yield* GitHubOAuth;

    yield* oauth.revokeGrant(githubToken.value).pipe(
      Effect.zipRight(
        logInfo("github_grant_revoked", { userId: session.userId }),
      ),
      Effect.catchAll((error) =>
        logError("github_grant_revoke_failed", {
          userId: session.userId,
          errorCode: error._tag,
        }),
      ),
    );
  });

/**
 * Deletes a workspace's data (owner only, docs/ACCOUNT_DELETION.md):
 * refuses while a subscription would keep charging, uninstalls the GitHub
 * App from the account, then deletes its repositories, reviews, members,
 * audit history, and Gemini key in one batch. Uninstalling comes first:
 * while the App is installed, GitHub keeps sending webhooks that would
 * store new data. If GitHub fails, nothing is deleted and the owner can
 * try again; installations already gone count as uninstalled.
 */
export const deleteWorkspace = (
  access: SessionAccess,
  workspaceId: number,
  confirmation: string,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "delete_workspace",
    );

    if (!confirms(confirmation, viewer.workspace.githubAccountLogin)) {
      return yield* new ConfirmationMismatchError();
    }

    yield* ensureNoRenewingSubscription(viewer.workspace);

    const github = yield* GitHubAppInstallations;

    const installations =
      yield* GitHubInstallationRepository.listForWorkspace(workspaceId);

    yield* Effect.forEach(
      installations,
      (installation) =>
        installation.status === "removed"
          ? Effect.void
          : github.uninstall(installation.githubInstallationId),
      { discard: true },
    );

    yield* WorkspaceRepository.deleteDataWithAudit(workspaceId, access.userId);

    yield* logInfo("workspace_data_deleted", {
      workspaceId,
      actorUserId: access.userId,
      installationCount: installations.length,
    });
  });

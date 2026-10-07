import { Effect, Match, Option } from "effect";
import {
  GitHubInstallationRepository,
  GitHubRepositoryRepository,
} from "@not-quite-my-tempo/db";
import type { GitHubInstallationStatus } from "@not-quite-my-tempo/db";

import { GitHubAppAuth } from "../github/app-auth.js";
import { GitHubInstallationClient } from "../github/installation-client.js";
import type {
  InstallationEvent,
  InstallationIdentity,
} from "../github/installation-event.js";
import { logError, logInfo } from "../logging.js";

const upsertInstallation = (
  event: InstallationIdentity,
  status: GitHubInstallationStatus,
) =>
  GitHubInstallationRepository.upsert({
    githubInstallationId: event.installationId,
    githubAccountId: event.accountId,
    githubAccountLogin: event.accountLogin,
    accountType: event.accountType,
    status,
  });

/**
 * Marks the installation active and reconciles its repositories with the
 * list GitHub reports. Idempotent, so webhooks and sign-in can both run it.
 */
export const syncInstallation = (event: InstallationIdentity) =>
  Effect.gen(function* () {
    const auth = yield* GitHubAppAuth;
    const client = yield* GitHubInstallationClient;

    const installation = yield* upsertInstallation(event, "active");
    const token = yield* auth.mintInstallationToken(event.installationId);
    const repositories = yield* client.listRepositories(token.token);

    yield* GitHubRepositoryRepository.syncForInstallation(
      installation.id,
      repositories,
    );

    yield* logInfo("github_installation_synced", {
      installationId: event.installationId,
      repositoryCount: repositories.length,
    });

    return {
      status: "synced" as const,
      repositoryCount: repositories.length,
    };
  });

/**
 * Applies an installation delivery. Suspended and removed installations stop
 * new reviews (`handleReviewRequest` checks status) but keep their history.
 */
export const handleInstallationEvent = (event: InstallationEvent) =>
  Match.value(event.effect).pipe(
    Match.when("sync", () => syncInstallation(event)),
    Match.when("suspend", () =>
      upsertInstallation(event, "suspended").pipe(
        Effect.tap(() =>
          logInfo("github_installation_suspended", {
            installationId: event.installationId,
          }),
        ),
        Effect.as({ status: "suspended" as const }),
      ),
    ),
    Match.when("remove", () =>
      Effect.gen(function* () {
        const [stored] =
          yield* GitHubInstallationRepository.listByGithubInstallationIds([
            event.installationId,
          ]);

        // Never stored, or deleted with its workspace's data (which is what
        // uninstalls it). Storing it now would bring back deleted data.
        if (stored === undefined) {
          yield* logInfo("github_installation_remove_ignored", {
            installationId: event.installationId,
          });

          return { status: "removed" as const };
        }

        const installation = yield* upsertInstallation(event, "removed");

        yield* GitHubRepositoryRepository.removeAllForInstallation(
          installation.id,
        );

        yield* logInfo("github_installation_removed", {
          installationId: event.installationId,
        });

        return { status: "removed" as const };
      }),
    ),
    Match.exhaustive,
  );

/**
 * Syncs, during sign-in, the installations GitHub says this user can see
 * that are not stored yet, plus the one they just installed or changed.
 * Only installations from the user's own `/user/installations` list are
 * synced, so an `installation_id` from a redirect cannot claim someone
 * else's installation. Failures are logged, not raised: the installation
 * webhooks sync the same state and sign-in must not depend on them.
 */
export const syncUserInstallations = (
  installations: readonly InstallationIdentity[],
  pendingInstallationId: Option.Option<number>,
) =>
  Effect.gen(function* () {
    const stored =
      yield* GitHubInstallationRepository.listByGithubInstallationIds(
        installations.map((installation) => installation.installationId),
      );

    const storedIds = new Set(
      stored.map((installation) => installation.githubInstallationId),
    );

    const toSync = installations.filter(
      (installation) =>
        !storedIds.has(installation.installationId) ||
        Option.contains(pendingInstallationId, installation.installationId),
    );

    yield* Effect.forEach(
      toSync,
      (installation) =>
        syncInstallation(installation).pipe(
          Effect.catchAll((error) =>
            logError("github_installation_sign_in_sync_failed", {
              installationId: installation.installationId,
              errorCode: error._tag,
            }),
          ),
        ),
      { discard: true },
    );
  });

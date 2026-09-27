import { Effect, Match } from "effect";
import {
  GitHubInstallationRepository,
  GitHubRepositoryRepository,
} from "@not-quite-my-tempo/db";
import type { GitHubInstallationStatus } from "@not-quite-my-tempo/db";

import { GitHubAppAuth } from "../github/app-auth.js";
import { GitHubInstallationClient } from "../github/installation-client.js";
import type { InstallationEvent } from "../github/installation-event.js";
import { logInfo } from "../logging.js";

const upsertInstallation = (
  event: InstallationEvent,
  status: GitHubInstallationStatus,
) =>
  GitHubInstallationRepository.upsert({
    githubInstallationId: event.installationId,
    githubAccountId: event.accountId,
    githubAccountLogin: event.accountLogin,
    accountType: event.accountType,
    status,
  });

const syncInstallation = (event: InstallationEvent) =>
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

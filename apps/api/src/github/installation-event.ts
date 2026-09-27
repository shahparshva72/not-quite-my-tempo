import { Effect, Option, Schema } from "effect";

import { GitHubId, InvalidGitHubPayloadError } from "./review-request.js";

/**
 * What an installation delivery means for stored state: `sync` re-reads the
 * installation's repositories from GitHub, `suspend` and `remove` stop new
 * reviews without calling GitHub (the app has lost access).
 */
export type InstallationEventEffect = "sync" | "suspend" | "remove";

export interface InstallationIdentity {
  readonly installationId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly accountType: string;
}

export interface InstallationEvent extends InstallationIdentity {
  readonly effect: InstallationEventEffect;
}

const installationActions = new Map<string, InstallationEventEffect>([
  ["created", "sync"],
  ["new_permissions_accepted", "sync"],
  ["unsuspend", "sync"],
  ["suspend", "suspend"],
  ["deleted", "remove"],
]);

// Selection changes are reconciled against GitHub's full list rather than
// applied from the (possibly partial) added/removed arrays.
const installationRepositoriesActions = new Map<
  string,
  InstallationEventEffect
>([
  ["added", "sync"],
  ["removed", "sync"],
]);

const InstallationWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({
    id: GitHubId,
    account: Schema.Struct({
      id: GitHubId,
      login: Schema.NonEmptyString,
      type: Schema.NonEmptyString,
    }),
  }),
});

/**
 * Decodes `installation` and `installation_repositories` deliveries. Returns
 * `None` for actions that do not change stored state.
 */
export const decodeInstallationBody = (
  githubEvent: "installation" | "installation_repositories",
  rawBody: ArrayBuffer,
) =>
  Schema.decodeUnknown(Schema.parseJson(InstallationWebhook))(
    new TextDecoder().decode(rawBody),
  ).pipe(
    Effect.mapError(
      () =>
        new InvalidGitHubPayloadError({
          message: "GitHub webhook payload does not match the expected schema",
        }),
    ),
    Effect.map((webhook) => {
      const actions =
        githubEvent === "installation"
          ? installationActions
          : installationRepositoriesActions;

      return Option.fromNullable(actions.get(webhook.action)).pipe(
        Option.map((effect): InstallationEvent => ({
          effect,
          installationId: webhook.installation.id,
          accountId: webhook.installation.account.id,
          accountLogin: webhook.installation.account.login,
          accountType: webhook.installation.account.type,
        })),
      );
    }),
  );

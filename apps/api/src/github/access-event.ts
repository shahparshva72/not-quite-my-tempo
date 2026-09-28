import { Effect, Option, Schema } from "effect";

import { GitHubId, InvalidGitHubPayloadError } from "./review-request.js";

/**
 * Deliveries that take access away from a person, as opposed to an
 * installation. Only the removing actions matter; everything else is
 * ignored.
 */
export type AccessRevocation =
  | { readonly kind: "app_revoked"; readonly githubUserId: number }
  | {
      readonly kind: "org_member_removed";
      readonly githubUserId: number;
      readonly githubAccountId: number;
    };

const AppAuthorizationWebhook = Schema.Struct({
  action: Schema.String,
  sender: Schema.Struct({ id: GitHubId }),
});

const OrganizationWebhook = Schema.Struct({
  action: Schema.String,
  organization: Schema.Struct({ id: GitHubId }),
  membership: Schema.optional(
    Schema.Struct({ user: Schema.Struct({ id: GitHubId }) }),
  ),
});

const invalidPayload = () =>
  new InvalidGitHubPayloadError({
    message: "GitHub webhook payload does not match the expected schema",
  });

export const decodeAccessRevocation = (
  githubEvent: "github_app_authorization" | "organization",
  rawBody: ArrayBuffer,
): Effect.Effect<
  Option.Option<AccessRevocation>,
  InvalidGitHubPayloadError
> => {
  const json = new TextDecoder().decode(rawBody);

  return githubEvent === "github_app_authorization"
    ? Schema.decodeUnknown(Schema.parseJson(AppAuthorizationWebhook))(
        json,
      ).pipe(
        Effect.mapError(invalidPayload),
        Effect.map((webhook) =>
          webhook.action === "revoked"
            ? Option.some<AccessRevocation>({
                kind: "app_revoked",
                githubUserId: webhook.sender.id,
              })
            : Option.none(),
        ),
      )
    : Schema.decodeUnknown(Schema.parseJson(OrganizationWebhook))(json).pipe(
        Effect.mapError(invalidPayload),
        Effect.map((webhook) =>
          webhook.action === "member_removed" &&
          webhook.membership !== undefined
            ? Option.some<AccessRevocation>({
                kind: "org_member_removed",
                githubUserId: webhook.membership.user.id,
                githubAccountId: webhook.organization.id,
              })
            : Option.none(),
        ),
      );
};

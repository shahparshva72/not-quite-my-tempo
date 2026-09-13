import { Data, Effect, Match, Option } from "effect";

import { handleReviewRequest } from "../application/review-requests.js";
import { logInfo } from "../logging.js";
import { decodePullRequestBody } from "./review-request.js";
import { verifyGitHubWebhookSignature } from "./signature.js";

export class InvalidWebhookSignatureError extends Data.TaggedError(
  "InvalidWebhookSignatureError",
) {}

type GitHubWebhookResult =
  | { readonly status: "ignored" }
  | { readonly status: "rate_limited" }
  | { readonly status: "already_processed"; readonly reviewRunId: number }
  | { readonly status: "queued"; readonly reviewRunId: number };

const ignoredWebhook = Effect.succeed<GitHubWebhookResult>({
  status: "ignored",
});

export const processGitHubWebhook = (
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
  githubEvent: string,
  webhookSecret: string,
) =>
  Effect.gen(function* () {
    yield* verifyGitHubWebhookSignature(
      rawBody,
      signatureHeader,
      webhookSecret,
    ).pipe(
      Effect.filterOrFail(
        (signatureValid) => signatureValid,
        () => new InvalidWebhookSignatureError(),
      ),
    );

    yield* logInfo("github_webhook_received", { githubEvent });

    return yield* Match.value(githubEvent).pipe(
      Match.when("pull_request", () =>
        decodePullRequestBody(rawBody).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => ignoredWebhook,
              onSome: (request) =>
                handleReviewRequest(request).pipe(
                  Effect.map((result): GitHubWebhookResult => result),
                ),
            }),
          ),
        ),
      ),
      Match.orElse(() => ignoredWebhook),
    );
  });

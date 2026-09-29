import { Data, Effect, Option } from "effect";
import {
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import type { ReviewKeySource } from "@not-quite-my-tempo/db";

import { decryptToken } from "../auth/token-cipher.js";
import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import type { ReviewRequest } from "../github/review-request.js";
import { logError, logInfo } from "../logging.js";
import { ReviewRunNotFoundError } from "./review-workflow.js";
import { FREE_TRIAL_REVIEWS, geminiKeyContext } from "./workspace-settings.js";

/** The workspace's stored Gemini key couldn't be decrypted. */
export class GeminiKeyUnreadableError extends Data.TaggedError(
  "GeminiKeyUnreadableError",
) {}

/** Gemini refused the workspace's own key (HTTP 400/401/403). */
export class WorkspaceGeminiKeyRejectedError extends Data.TaggedError(
  "WorkspaceGeminiKeyRejectedError",
)<{
  readonly status: number;
}> {}

/**
 * Where a run's Gemini key comes from, plus the IDs later steps need. It
 * is a Workflow step output, so it must never contain the key itself.
 */
export interface ReviewKeyChoice {
  readonly source: ReviewKeySource | "none";
  readonly repositoryId: number;
  readonly workspaceId: number | null;
}

/**
 * Decides which Gemini key a run uses, just before the Gemini call
 * (docs/BYOK_TRIAL_DESIGN.md): the workspace's key, else one free trial
 * review on the platform key (taken atomically), else none. Returns only
 * the source, never the key, because Workflow step outputs are persisted.
 */
export const chooseReviewKey = (reviewRunId: number) =>
  Effect.gen(function* () {
    const run = yield* ReviewRunRepository.findById(reviewRunId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new ReviewRunNotFoundError({ reviewRunId }),
          onSome: Effect.succeed,
        }),
      ),
    );

    const workspace = yield* WorkspaceRepository.findByRepositoryId(
      run.repositoryId,
    );

    const choice = (source: ReviewKeyChoice["source"]): ReviewKeyChoice => ({
      source,
      repositoryId: run.repositoryId,
      workspaceId: Option.getOrNull(workspace)?.id ?? null,
    });

    if (Option.isNone(workspace)) {
      return choice("none");
    }

    if (workspace.value.geminiKeyCiphertext !== null) {
      yield* ReviewRunRepository.setKeySource(reviewRunId, "workspace");

      return choice("workspace");
    }

    const trial = yield* WorkspaceRepository.takeTrialReview(
      workspace.value.id,
      FREE_TRIAL_REVIEWS,
    );

    if (Option.isNone(trial)) {
      return choice("none");
    }

    yield* ReviewRunRepository.setKeySource(reviewRunId, "platform");
    yield* logInfo("trial_review_taken", {
      workspaceId: workspace.value.id,
      reviewRunId,
      remaining: FREE_TRIAL_REVIEWS - trial.value,
    });

    return choice("platform");
  });

/**
 * The key for a run's chosen source. Called inside the Gemini step so the
 * decrypted key never leaves it.
 */
export const resolveGeminiKey = (
  repositoryId: number,
  source: ReviewKeySource,
  platformKey: string,
  encryptionKey: string | undefined,
) =>
  source === "platform"
    ? Effect.succeed(platformKey)
    : WorkspaceRepository.findByRepositoryId(repositoryId).pipe(
        Effect.flatMap((workspace) =>
          Option.match(workspace, {
            onNone: () => new GeminiKeyUnreadableError(),
            onSome: (found) =>
              found.geminiKeyCiphertext === null
                ? new GeminiKeyUnreadableError()
                : decryptToken(
                    encryptionKey,
                    found.geminiKeyCiphertext,
                    geminiKeyContext(found.id),
                  ).pipe(Effect.mapError(() => new GeminiKeyUnreadableError())),
          }),
        ),
      );

const blockedComment = (workspaceId: number | null, appOrigin?: string) => {
  const where =
    appOrigin === undefined || workspaceId === null
      ? "in Not Quite My Tempo's workspace settings"
      : `at ${appOrigin}/workspaces/${workspaceId}/settings`;

  return `### 🥁 Fletcher can't review this yet

This workspace has used its 5 free reviews and has no Gemini API key. An admin or owner can add one ${where}, then comment \`/fletcher again\` here.`;
};

/**
 * Explains a blocked review on the pull request, once per pull request.
 * Failures are logged, not raised: the run is marked blocked either way.
 */
export const explainMissingKey = (
  installationToken: string,
  request: ReviewRequest,
  reviewRunId: number,
  repositoryId: number,
  workspaceId: number | null,
  appOrigin?: string,
) =>
  Effect.gen(function* () {
    const alreadyExplained = yield* ReviewRunRepository.hasEarlierBlockedRun(
      repositoryId,
      request.pullRequestNumber,
      reviewRunId,
    );

    if (alreadyExplained) {
      return;
    }

    const client = yield* GitHubPullRequestClient;

    yield* client.createIssueComment(
      installationToken,
      {
        owner: request.owner,
        repo: request.repo,
        pullRequestNumber: request.pullRequestNumber,
      },
      blockedComment(workspaceId, appOrigin),
    );
  }).pipe(
    Effect.catchAll((error) =>
      logError("blocked_review_comment_failed", {
        reviewRunId,
        errorCode: error._tag,
      }),
    ),
  );

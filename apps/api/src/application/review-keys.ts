import { Clock, Data, Effect, Option } from "effect";
import {
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import type { DatabaseError, ReviewKeySource } from "@not-quite-my-tempo/db";
import type { GeminiProvider } from "@not-quite-my-tempo/gemini";

import { decryptToken } from "../auth/token-cipher.js";
import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import type { ReviewRequest } from "../github/review-request.js";
import { logError, logInfo } from "../logging.js";
import { hasPaidPlan } from "./billing.js";
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
 * Free trial reviews allowed per rolling 24 hours across every workspace,
 * unless TRIAL_DAILY_REVIEW_CAP says otherwise. A brake on platform-key
 * spend from people opening many accounts; 0 pauses the trial entirely.
 */
export const DEFAULT_TRIAL_DAILY_REVIEW_CAP = 100;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** TRIAL_DAILY_REVIEW_CAP as a count; the default when unset or invalid. */
export const trialDailyReviewCap = (value: string | undefined) => {
  const cap = Number(value);

  return value !== undefined &&
    value.trim() !== "" &&
    Number.isInteger(cap) &&
    cap >= 0
    ? cap
    : DEFAULT_TRIAL_DAILY_REVIEW_CAP;
};

/**
 * Where a run's Gemini key comes from, plus the IDs later steps need. It
 * is a Workflow step output, so it must never contain the key itself.
 * "none": no key and no free reviews left; "trial_paused": free reviews
 * left, but the platform-wide daily trial cap is reached.
 */
export interface ReviewKeyChoice {
  readonly source: ReviewKeySource | "none" | "trial_paused";
  readonly repositoryId: number;
  readonly workspaceId: number | null;
}

/**
 * Decides which Gemini key a run uses, just before the Gemini call
 * (docs/BYOK_TRIAL_DESIGN.md): the workspace's key, else the platform key
 * on a paid plan (docs/BILLING.md), else one free trial review on the
 * platform key (taken atomically, within the platform-wide daily trial
 * cap), else none. Returns only the source, never the key, because
 * Workflow step outputs are persisted.
 */
export const chooseReviewKey = (
  reviewRunId: number,
  trialDailyCap: number = DEFAULT_TRIAL_DAILY_REVIEW_CAP,
) =>
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

    // A retried step finds the source it already recorded, so it never
    // claims a second free review for the same run.
    if (run.keySource !== null) {
      return choice(run.keySource);
    }

    if (Option.isNone(workspace)) {
      return choice("none");
    }

    if (workspace.value.geminiKeyCiphertext !== null) {
      yield* ReviewRunRepository.setKeySource(reviewRunId, "workspace");

      return choice("workspace");
    }

    if (hasPaidPlan(workspace.value, new Date())) {
      yield* ReviewRunRepository.setKeySource(reviewRunId, "subscription");

      return choice("subscription");
    }

    const now = yield* Clock.currentTimeMillis;

    const claimed = yield* ReviewRunRepository.claimTrialReview(
      reviewRunId,
      workspace.value.id,
      FREE_TRIAL_REVIEWS,
      { limit: trialDailyCap, since: new Date(now - DAY_MILLIS) },
    );

    if (!claimed) {
      const [usage] = yield* ReviewRunRepository.trialReviewsUsed([
        workspace.value.id,
      ]);

      // Free reviews left means the platform-wide cap refused the claim.
      if ((usage?.used ?? 0) < FREE_TRIAL_REVIEWS) {
        yield* logError("trial_daily_cap_reached", {
          workspaceId: workspace.value.id,
          reviewRunId,
          trialDailyCap,
        });

        return choice("trial_paused");
      }

      return choice("none");
    }

    yield* logInfo("trial_review_claimed", {
      workspaceId: workspace.value.id,
      reviewRunId,
    });

    return choice("platform");
  });

/** A decrypted key and the Google API it works with. */
export interface ResolvedGeminiKey {
  readonly apiKey: string;
  readonly provider: GeminiProvider;
}

/**
 * The key for a run's chosen source. Called inside the Gemini step so the
 * decrypted key never leaves it. Workspace keys saved before providers were
 * recorded are Gemini API keys.
 */
export const resolveGeminiKey = (
  repositoryId: number,
  source: ReviewKeySource,
  platform: ResolvedGeminiKey,
  encryptionKey: string | undefined,
): Effect.Effect<
  ResolvedGeminiKey,
  GeminiKeyUnreadableError | DatabaseError,
  WorkspaceRepository
> =>
  source === "platform" || source === "subscription"
    ? Effect.succeed(platform)
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
                  ).pipe(
                    Effect.map((apiKey): ResolvedGeminiKey => ({
                      apiKey,
                      provider: found.geminiKeyProvider ?? "gemini_api",
                    })),
                    Effect.mapError(() => new GeminiKeyUnreadableError()),
                  ),
          }),
        ),
      );

const blockedComment = (
  workspaceId: number | null,
  billingEnabled: boolean,
  appOrigin?: string,
) => {
  const where =
    appOrigin === undefined || workspaceId === null
      ? "in Not Quite My Tempo's workspace settings"
      : `at ${appOrigin}/workspaces/${workspaceId}/settings`;

  // Subscribing is only offered where billing is set up (docs/BILLING.md).
  const situation = billingEnabled
    ? `has no Gemini API key, and isn't on the paid plan. An admin or owner can add a key or subscribe ${where}`
    : `and has no Gemini API key. An admin or owner can add one ${where}`;

  return `### 🥁 Fletcher can't review this yet

This workspace has used its 5 free reviews ${situation}, then comment \`/fletcher again\` here.`;
};

const pausedComment = (
  workspaceId: number | null,
  billingEnabled: boolean,
  appOrigin?: string,
) => {
  const where =
    appOrigin === undefined || workspaceId === null
      ? "in Not Quite My Tempo's workspace settings"
      : `at ${appOrigin}/workspaces/${workspaceId}/settings`;

  const fix = billingEnabled
    ? `An admin or owner can add a Gemini API key or subscribe ${where}`
    : `An admin or owner can add a Gemini API key ${where}`;

  return `### 🥁 Fletcher can't review this yet

Free trial reviews are paused for today. ${fix}, then comment \`/fletcher again\` here. Or comment it tomorrow, once the trial is back.`;
};

/** Run error codes for reviews blocked before reaching Gemini. */
export type BlockedReviewCode = "no_gemini_key" | "trial_paused";

/**
 * Explains a blocked review on the pull request, once per pull request
 * and reason. Failures are logged, not raised: the run is marked blocked
 * either way.
 */
export const explainBlockedReview = (
  installationToken: string,
  request: ReviewRequest,
  reviewRunId: number,
  repositoryId: number,
  workspaceId: number | null,
  reason: BlockedReviewCode,
  billingEnabled: boolean,
  appOrigin?: string,
) =>
  Effect.gen(function* () {
    const alreadyExplained = yield* ReviewRunRepository.hasEarlierBlockedRun(
      repositoryId,
      request.pullRequestNumber,
      reviewRunId,
      reason,
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
      reason === "no_gemini_key"
        ? blockedComment(workspaceId, billingEnabled, appOrigin)
        : pausedComment(workspaceId, billingEnabled, appOrigin),
    );
  }).pipe(
    Effect.catchAll((error) =>
      logError("blocked_review_comment_failed", {
        reviewRunId,
        errorCode: error._tag,
      }),
    ),
  );

import { Clock, Data, Effect, Match, Option } from "effect";
import {
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import type {
  DatabaseError,
  ReviewKeySource,
  Workspace,
} from "@not-quite-my-tempo/db";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODELS,
  DEFAULT_PLAN_CATALOG_MODEL,
  downgradeOrder,
  ENABLED_VENDORS,
  estimateInputTokens,
  findCatalogModel,
  isPlanModel,
  reviewCreditsX100,
  vendorOf,
} from "@not-quite-my-tempo/reviewer";
import type {
  CatalogModel,
  GeminiProvider,
  ModelVendor,
  ReviewProvider,
} from "@not-quite-my-tempo/reviewer";

import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import type { ReviewRequest } from "../github/review-request.js";
import { logError, logInfo } from "../logging.js";
import { hasPaidPlan } from "./billing.js";
import { ReviewRunNotFoundError } from "./review-workflow.js";
import {
  decryptWorkspaceKey,
  FREE_TRIAL_REVIEWS,
} from "./workspace-settings.js";

/** The workspace's stored key couldn't be decrypted. */
export class GeminiKeyUnreadableError extends Data.TaggedError(
  "GeminiKeyUnreadableError",
) {}

/**
 * The provider refused the workspace's own key: rejected, out of quota, or
 * unable to use the chosen model.
 */
export class WorkspaceReviewKeyError extends Data.TaggedError(
  "WorkspaceReviewKeyError",
)<{
  readonly reason: "key_rejected" | "quota_exceeded" | "model_unavailable";
  readonly provider: ReviewProvider;
  readonly status: number | null;
}> {}

/** A paid-plan run claimed a model whose platform key is no longer set. */
export class PlatformKeyMissingError extends Data.TaggedError(
  "PlatformKeyMissingError",
)<{
  readonly vendor: ModelVendor;
}> {}

/**
 * Free trial reviews allowed per rolling 24 hours across every workspace,
 * unless TRIAL_DAILY_REVIEW_CAP says otherwise. A brake on platform-key
 * spend from people opening many accounts; 0 pauses the trial entirely.
 */
export const DEFAULT_TRIAL_DAILY_REVIEW_CAP = 100;

/** Paid-plan credits per billing period, unless PLAN_MONTHLY_CREDITS says otherwise. */
export const DEFAULT_PLAN_MONTHLY_CREDITS = 200;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

// Polar periods are monthly; used only until a sync stores the real start.
const ASSUMED_PERIOD_MILLIS = 30 * DAY_MILLIS;

const nonNegativeInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);

  return value !== undefined &&
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 0
    ? parsed
    : fallback;
};

/** TRIAL_DAILY_REVIEW_CAP as a count; the default when unset or invalid. */
export const trialDailyReviewCap = (value: string | undefined) =>
  nonNegativeInteger(value, DEFAULT_TRIAL_DAILY_REVIEW_CAP);

/** PLAN_MONTHLY_CREDITS as a count; the default when unset or invalid. */
export const planMonthlyCredits = (value: string | undefined) =>
  nonNegativeInteger(value, DEFAULT_PLAN_MONTHLY_CREDITS);

/** Platform keys for paid-plan reviews, by vendor. */
export interface PlatformKeys {
  readonly gemini: {
    readonly apiKey: string;
    readonly provider: GeminiProvider;
  };
  readonly openai: string | null;
  readonly anthropic: string | null;
}

/**
 * Vendors whose models the paid plan can offer: enabled ones with a
 * platform key.
 */
export const platformVendors = (keys: PlatformKeys): ReadonlySet<ModelVendor> =>
  new Set<ModelVendor>(
    [
      "google" as const,
      ...(keys.openai === null ? [] : ["openai" as const]),
      ...(keys.anthropic === null ? [] : ["anthropic" as const]),
    ].filter((vendor) => ENABLED_VENDORS.has(vendor)),
  );

/** The paid-plan settings chooseReviewKey needs. */
export interface PlanSettings {
  readonly allowanceX100: number;
  readonly vendors: ReadonlySet<ModelVendor>;
  readonly geminiProvider: GeminiProvider;
}

/**
 * Where a run's key comes from, plus what later steps need. It is a
 * Workflow step output, so it must never contain a key.
 *
 * - "none": no key and no free reviews left.
 * - "trial_paused": free reviews left, but the platform-wide daily cap is
 *   reached.
 * - "credits_exhausted": a paid workspace with no plan model that fits its
 *   remaining credits, and no key of its own.
 */
export interface ReviewKeyChoice {
  readonly source:
    | ReviewKeySource
    | "none"
    | "trial_paused"
    | "credits_exhausted";
  readonly repositoryId: number;
  readonly workspaceId: number | null;
  /** On a paid-plan run: the claimed model, and the one it replaced. */
  readonly model: string | null;
  readonly requestedModel: string | null;
  readonly creditsX100: number | null;
}

/** When the workspace's current credit period started. */
export const creditPeriodStart = (workspace: Workspace) =>
  workspace.subscriptionPeriodStart ??
  (workspace.subscriptionPeriodEnd === null
    ? null
    : new Date(
        workspace.subscriptionPeriodEnd.getTime() - ASSUMED_PERIOD_MILLIS,
      ));

/** The plan model a workspace picked, or the default if it's no longer offered. */
export const chosenPlanModel = (
  workspace: Workspace,
  vendors: ReadonlySet<ModelVendor>,
): CatalogModel => {
  const picked =
    workspace.planModel === null
      ? undefined
      : findCatalogModel(workspace.planModel);

  return picked !== undefined &&
    isPlanModel(picked) &&
    vendors.has(picked.vendor)
    ? picked
    : DEFAULT_PLAN_CATALOG_MODEL;
};

const platformProviderFor = (
  model: CatalogModel,
  geminiProvider: GeminiProvider,
): ReviewProvider =>
  model.vendor === "google" ? geminiProvider : model.vendor;

/**
 * Claims paid-plan credits for the chosen model, or the first smaller model
 * from the same vendor that fits what's left. Each claim is one atomic
 * statement, so walking the list also covers a concurrent run taking the
 * credits first. Returns the claimed model, if any.
 */
const claimPlanReview = (
  reviewRunId: number,
  workspace: Workspace,
  periodStart: Date,
  diffBytes: number,
  plan: PlanSettings,
) =>
  Effect.gen(function* () {
    const chosen = chosenPlanModel(workspace, plan.vendors);

    const estimatedTokens = estimateInputTokens(diffBytes);

    for (const candidate of [chosen, ...downgradeOrder(chosen)]) {
      const creditsX100 = reviewCreditsX100(candidate, estimatedTokens);

      if (creditsX100 === null) {
        continue;
      }

      const requestedModel = candidate.id === chosen.id ? null : chosen.id;

      const claimed = yield* ReviewRunRepository.claimPlanCredits(reviewRunId, {
        workspaceId: workspace.id,
        periodStart,
        creditsX100,
        allowanceX100: plan.allowanceX100,
        model: candidate.id,
        provider: platformProviderFor(candidate, plan.geminiProvider),
        requestedModel,
      });

      if (claimed) {
        if (requestedModel !== null) {
          yield* logInfo("review_model_downgraded", {
            workspaceId: workspace.id,
            reviewRunId,
            requestedModel,
            model: candidate.id,
          });
        }

        return Option.some({
          model: candidate.id,
          requestedModel,
          creditsX100,
        });
      }
    }

    yield* logInfo("review_credits_exhausted", {
      workspaceId: workspace.id,
      reviewRunId,
      model: chosen.id,
    });

    return Option.none();
  });

/**
 * Decides which key a run uses, just before the model call. A paid
 * workspace spends plan credits first (switching to a smaller model when
 * the chosen one no longer fits), then falls back to its own key, else is
 * blocked. Other workspaces use their own key, else one free trial review
 * (within the platform-wide daily cap), else none. See
 * docs/MULTI_PROVIDER_BYOK_DESIGN.md. Returns only the source and model,
 * never a key, because Workflow step outputs are persisted.
 */
export const chooseReviewKey = (
  reviewRunId: number,
  diffBytes: number,
  plan: PlanSettings,
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

    const choice = (
      source: ReviewKeyChoice["source"],
      claim: {
        readonly model: string;
        readonly requestedModel: string | null;
        readonly creditsX100: number;
      } | null = null,
    ): ReviewKeyChoice => ({
      source,
      repositoryId: run.repositoryId,
      workspaceId: Option.getOrNull(workspace)?.id ?? null,
      model: claim?.model ?? null,
      requestedModel: claim?.requestedModel ?? null,
      creditsX100: claim?.creditsX100 ?? null,
    });

    // A retried step finds the source it already recorded, so it never
    // claims a second free review or charges credits twice.
    if (run.keySource !== null) {
      return choice(
        run.keySource,
        run.keySource === "subscription" && run.model !== null
          ? {
              model: run.model,
              requestedModel: run.requestedModel,
              creditsX100: run.creditsX100 ?? 0,
            }
          : null,
      );
    }

    if (Option.isNone(workspace)) {
      return choice("none");
    }

    const hasOwnKey = workspace.value.geminiKeyCiphertext !== null;

    const now = yield* Clock.currentTimeMillis;

    const periodStart = creditPeriodStart(workspace.value);

    if (hasPaidPlan(workspace.value, new Date(now)) && periodStart !== null) {
      const claimed = yield* claimPlanReview(
        reviewRunId,
        workspace.value,
        periodStart,
        diffBytes,
        plan,
      );

      if (Option.isSome(claimed)) {
        return choice("subscription", claimed.value);
      }

      if (!hasOwnKey) {
        return choice("credits_exhausted");
      }

      yield* ReviewRunRepository.setKeySource(reviewRunId, "workspace");

      return choice("workspace");
    }

    if (hasOwnKey) {
      yield* ReviewRunRepository.setKeySource(reviewRunId, "workspace");

      return choice("workspace");
    }

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

/** A decrypted key, the API it works with, and the model to ask. */
export interface ResolvedReviewKey {
  readonly apiKey: string;
  readonly provider: ReviewProvider;
  readonly model: string;
}

/**
 * The key and model for a run's chosen source. Called inside the review
 * step so the decrypted key never leaves it.
 */
export const resolveReviewKey = (
  choice: ReviewKeyChoice,
  platform: PlatformKeys,
  platformGeminiModel: string | undefined,
  encryptionKey: string | undefined,
): Effect.Effect<
  ResolvedReviewKey,
  GeminiKeyUnreadableError | PlatformKeyMissingError | DatabaseError,
  WorkspaceRepository
> => {
  if (choice.source === "platform") {
    return Effect.succeed({
      ...platform.gemini,
      model: platformGeminiModel ?? DEFAULT_GEMINI_MODEL,
    });
  }

  if (choice.source === "subscription") {
    const model =
      (choice.model === null ? undefined : findCatalogModel(choice.model)) ??
      DEFAULT_PLAN_CATALOG_MODEL;

    if (model.vendor === "google") {
      return Effect.succeed({ ...platform.gemini, model: model.id });
    }

    const apiKey = platform[model.vendor];

    return apiKey === null
      ? Effect.fail(new PlatformKeyMissingError({ vendor: model.vendor }))
      : Effect.succeed({ apiKey, provider: model.vendor, model: model.id });
  }

  return WorkspaceRepository.findByRepositoryId(choice.repositoryId).pipe(
    Effect.flatMap((workspace) =>
      Option.match(workspace, {
        onNone: () => Effect.fail(new GeminiKeyUnreadableError()),
        onSome: (found) =>
          decryptWorkspaceKey(found, encryptionKey).pipe(
            Effect.map((key): ResolvedReviewKey => ({
              ...key,
              model:
                found.reviewModel ?? DEFAULT_MODELS[vendorOf(key.provider)],
            })),
            Effect.mapError(() => new GeminiKeyUnreadableError()),
          ),
      }),
    ),
  );
};

const settingsLocation = (workspaceId: number | null, appOrigin?: string) =>
  appOrigin === undefined || workspaceId === null
    ? "in Not Quite My Tempo's workspace settings"
    : `at ${appOrigin}/workspaces/${workspaceId}/settings`;

const blockedComment = (
  workspaceId: number | null,
  billingEnabled: boolean,
  appOrigin?: string,
) => {
  const where = settingsLocation(workspaceId, appOrigin);

  // Subscribing is only offered where billing is set up (docs/BILLING.md).
  const situation = billingEnabled
    ? `has no review key, and isn't on the paid plan. An admin or owner can add a Gemini key or subscribe ${where}`
    : `and has no review key. An admin or owner can add a Gemini key ${where}`;

  return `### 🥁 Fletcher can't review this yet

This workspace has used its 5 free reviews ${situation}, then comment \`/fletcher again\` here.`;
};

const pausedComment = (
  workspaceId: number | null,
  billingEnabled: boolean,
  appOrigin?: string,
) => {
  const where = settingsLocation(workspaceId, appOrigin);

  const fix = billingEnabled
    ? `An admin or owner can add a Gemini key or subscribe ${where}`
    : `An admin or owner can add a Gemini key ${where}`;

  return `### 🥁 Fletcher can't review this yet

Free trial reviews are paused for today. ${fix}, then comment \`/fletcher again\` here. Or comment it tomorrow, once the trial is back.`;
};

const creditsComment = (
  workspaceId: number | null,
  allowance: number,
  renewsOn: Date | null,
  appOrigin?: string,
) => {
  const renewal =
    renewsOn === null
      ? "until the plan renews"
      : `until ${renewsOn.toISOString().slice(0, 10)}`;

  return `### 🥁 Fletcher can't review this yet

This workspace has used its ${allowance} review credits for this period, ${renewal}. To keep reviewing now, an admin or owner can add your own Gemini key ${settingsLocation(workspaceId, appOrigin)}, then comment \`/fletcher again\` here.`;
};

/** Run error codes for reviews blocked before reaching a model. */
export type BlockedReviewCode =
  | "no_gemini_key"
  | "trial_paused"
  | "credits_exhausted";

/** What the blocked-review comment needs to know about the workspace. */
export interface BlockedReviewContext {
  readonly billingEnabled: boolean;
  readonly creditAllowance: number;
  readonly appOrigin: string | undefined;
}

/**
 * Explains a blocked review on the pull request, once per pull request
 * and reason (and per credit period, for credits_exhausted). Failures are
 * logged, not raised: the run is marked blocked either way.
 */
export const explainBlockedReview = (
  installationToken: string,
  request: ReviewRequest,
  reviewRunId: number,
  repositoryId: number,
  workspaceId: number | null,
  reason: BlockedReviewCode,
  context: BlockedReviewContext,
) =>
  Effect.gen(function* () {
    const workspace =
      workspaceId === null
        ? Option.none()
        : yield* WorkspaceRepository.findById(workspaceId);

    const periodStart = Option.getOrNull(
      Option.flatMapNullable(workspace, creditPeriodStart),
    );

    const alreadyExplained = yield* ReviewRunRepository.hasEarlierBlockedRun(
      repositoryId,
      request.pullRequestNumber,
      reviewRunId,
      reason,
      reason === "credits_exhausted" ? periodStart : null,
    );

    if (alreadyExplained) {
      return;
    }

    const client = yield* GitHubPullRequestClient;

    const body = Match.value(reason).pipe(
      Match.when("no_gemini_key", () =>
        blockedComment(workspaceId, context.billingEnabled, context.appOrigin),
      ),
      Match.when("trial_paused", () =>
        pausedComment(workspaceId, context.billingEnabled, context.appOrigin),
      ),
      Match.when("credits_exhausted", () =>
        creditsComment(
          workspaceId,
          context.creditAllowance,
          Option.getOrNull(workspace)?.subscriptionPeriodEnd ?? null,
          context.appOrigin,
        ),
      ),
      Match.exhaustive,
    );

    yield* client.createIssueComment(
      installationToken,
      {
        owner: request.owner,
        repo: request.repo,
        pullRequestNumber: request.pullRequestNumber,
      },
      body,
    );
  }).pipe(
    Effect.catchAll((error) =>
      logError("blocked_review_comment_failed", {
        reviewRunId,
        errorCode: error._tag,
      }),
    ),
  );

/**
 * The line a downgraded review starts with, so readers know a smaller model
 * wrote it and why.
 */
export const downgradeNotice = (choice: ReviewKeyChoice) =>
  choice.source !== "subscription" ||
  choice.requestedModel === null ||
  choice.model === null
    ? null
    : `_Switched to a smaller model: this review used \`${choice.model}\` instead of \`${choice.requestedModel}\` because the workspace is low on review credits for this period._`;

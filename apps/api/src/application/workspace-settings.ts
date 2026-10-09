import { Context, Data, Effect, Layer, Match, Option } from "effect";
import {
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import type { Workspace } from "@not-quite-my-tempo/db";
import {
  checkGeminiKey,
  ENABLED_VENDORS,
  findCatalogModel,
  isPlanModel,
  listReviewModels,
  vendorOf,
} from "@not-quite-my-tempo/reviewer";
import type {
  ModelListUnavailableError,
  ModelVendor,
  ReviewProvider,
} from "@not-quite-my-tempo/reviewer";

import { decryptToken, encryptToken } from "../auth/token-cipher.js";
import { logInfo } from "../logging.js";
import { authorizeWorkspace } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";

/** Platform-key reviews every workspace gets before it needs its own key. */
export const FREE_TRIAL_REVIEWS = 5;

/**
 * Encryption context binding a stored key to its workspace and provider.
 * Google keys keep the original context so keys saved before OpenAI and
 * Anthropic were added still decrypt.
 */
export const reviewKeyContext = (
  workspaceId: number,
  provider: ReviewProvider,
) =>
  vendorOf(provider) === "google"
    ? `workspace:${workspaceId}:gemini`
    : `workspace:${workspaceId}:${provider}`;

export class InvalidReviewKeyError extends Data.TaggedError(
  "InvalidReviewKeyError",
)<{
  readonly reason:
    | "format"
    | "rejected"
    | "wrong_provider"
    | "provider_disabled";
}> {}

/** The provider couldn't check the key, so it wasn't stored. */
export class ReviewKeyCheckUnavailableError extends Data.TaggedError(
  "ReviewKeyCheckUnavailableError",
) {}

export class NoReviewKeyError extends Data.TaggedError("NoReviewKeyError") {}

/** The model isn't one this workspace may choose. */
export class ModelNotAllowedError extends Data.TaggedError(
  "ModelNotAllowedError",
)<{
  readonly model: string;
}> {}

export interface ReviewKeyCheckerService {
  /** The API that accepts the key, or None when the provider rejects it. */
  readonly check: (
    vendor: ModelVendor,
    apiKey: string,
  ) => Effect.Effect<
    Option.Option<ReviewProvider>,
    ReviewKeyCheckUnavailableError
  >;
  /** Supported models the key can use; None when the key is rejected. */
  readonly listModels: (
    provider: ReviewProvider,
    apiKey: string,
  ) => Effect.Effect<
    Option.Option<readonly string[]>,
    ModelListUnavailableError
  >;
}

export class ReviewKeyChecker extends Context.Tag(
  "@not-quite-my-tempo/api/ReviewKeyChecker",
)<ReviewKeyChecker, ReviewKeyCheckerService>() {}

export const ReviewKeyCheckerLive = Layer.succeed(
  ReviewKeyChecker,
  ReviewKeyChecker.of({
    check: (vendor, apiKey) =>
      Match.value(vendor).pipe(
        Match.when("google", () => checkGeminiKey(apiKey)),
        Match.orElse((other) =>
          listReviewModels(other, apiKey).pipe(
            Effect.map(Option.map((): ReviewProvider => other)),
          ),
        ),
        Effect.mapError(() => new ReviewKeyCheckUnavailableError()),
      ),
    listModels: (provider, apiKey) => listReviewModels(provider, apiKey),
  }),
);

export interface TrialStatus {
  readonly used: number;
  readonly total: number;
  readonly remaining: number;
}

/** `used` comes from ReviewRunRepository.trialReviewsUsed (derived). */
export const trialStatus = (used: number): TrialStatus => ({
  used,
  total: FREE_TRIAL_REVIEWS,
  remaining: Math.max(0, FREE_TRIAL_REVIEWS - used),
});

/** Settings page data. Never includes the key, only its last 4. */
export const workspaceSettings = (access: SessionAccess, workspaceId: number) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "view_settings",
    );

    const [usage] = yield* ReviewRunRepository.trialReviewsUsed([workspaceId]);

    const creditsUsedX100 =
      viewer.workspace.subscriptionPeriodStart === null
        ? 0
        : yield* ReviewRunRepository.creditsUsedX100(
            workspaceId,
            viewer.workspace.subscriptionPeriodStart,
          );

    return {
      workspace: viewer.workspace,
      viewerRole: viewer.role,
      trial: trialStatus(usage?.used ?? 0),
      creditsUsedX100,
    };
  });

// Only catches paste mistakes (whitespace, quotes, a whole "NAME=value"
// line) before any network call; the provider decides whether the key is
// valid. Google keys come in more than one format.
const KEY_PATTERNS: Readonly<Record<ModelVendor, RegExp>> = {
  google: /^[A-Za-z0-9._~+/-]{20,512}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,512}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,512}$/,
};

const keyFormatProblem = (vendor: ModelVendor, apiKey: string) =>
  // An Anthropic key pasted under OpenAI: both start with "sk-".
  vendor === "openai" && apiKey.startsWith("sk-ant-")
    ? Option.some<InvalidReviewKeyError["reason"]>("wrong_provider")
    : KEY_PATTERNS[vendor].test(apiKey)
      ? Option.none()
      : Option.some<InvalidReviewKeyError["reason"]>("format");

/**
 * Checks the key with its provider, then stores it encrypted. A key the
 * provider rejects, or couldn't check, is never stored. A key from the same
 * vendor keeps the chosen model; switching vendors resets it.
 */
export const saveReviewKey = (
  access: SessionAccess,
  workspaceId: number,
  vendor: ModelVendor,
  rawKey: string,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_settings",
    );

    if (!ENABLED_VENDORS.has(vendor)) {
      return yield* new InvalidReviewKeyError({ reason: "provider_disabled" });
    }

    const apiKey = rawKey.trim();

    const problem = keyFormatProblem(vendor, apiKey);

    if (Option.isSome(problem)) {
      return yield* new InvalidReviewKeyError({ reason: problem.value });
    }

    const checker = yield* ReviewKeyChecker;

    const provider = yield* checker.check(vendor, apiKey);

    if (Option.isNone(provider)) {
      return yield* new InvalidReviewKeyError({ reason: "rejected" });
    }

    const ciphertext = yield* encryptToken(
      encryptionKey,
      apiKey,
      reviewKeyContext(workspaceId, provider.value),
    );

    const previous = viewer.workspace.geminiKeyProvider;

    yield* WorkspaceRepository.saveReviewKeyWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousLast4: viewer.workspace.geminiKeyLast4,
      ciphertext,
      last4: apiKey.slice(-4),
      provider: provider.value,
      model:
        previous !== null && vendorOf(previous) === vendor
          ? viewer.workspace.reviewModel
          : null,
    });

    yield* logInfo("review_key_saved", {
      workspaceId,
      actorUserId: access.userId,
      provider: provider.value,
    });
  });

export const removeReviewKey = (access: SessionAccess, workspaceId: number) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_settings",
    );

    // Removing a key that isn't there is a no-op, so repeats audit nothing.
    if (viewer.workspace.geminiKeyLast4 === null) {
      return;
    }

    yield* WorkspaceRepository.removeReviewKeyWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousLast4: viewer.workspace.geminiKeyLast4,
    });

    yield* logInfo("review_key_removed", {
      workspaceId,
      actorUserId: access.userId,
    });
  });

/** The workspace's own key, decrypted, with the API it works with. */
export const decryptWorkspaceKey = (
  workspace: Workspace,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    if (workspace.geminiKeyCiphertext === null) {
      return yield* new NoReviewKeyError();
    }

    // Keys saved before providers were recorded are Gemini API keys.
    const provider: ReviewProvider =
      workspace.geminiKeyProvider ?? "gemini_api";

    const apiKey = yield* decryptToken(
      encryptionKey,
      workspace.geminiKeyCiphertext,
      reviewKeyContext(workspace.id, provider),
    );

    return { apiKey, provider };
  });

/**
 * The models the workspace's own key can use, for the settings picker.
 * None when there's no key or the list couldn't be read; the page then
 * offers a plain model ID field.
 */
export const ownKeyModelOptions = (
  workspace: Workspace,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    const key = yield* decryptWorkspaceKey(workspace, encryptionKey);

    const checker = yield* ReviewKeyChecker;

    return yield* checker.listModels(key.provider, key.apiKey);
  }).pipe(Effect.orElseSucceed(() => Option.none<readonly string[]>()));

// Model IDs end up in Gemini's URL path; anything else is a paste mistake.
const MODEL_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Sets the model own-key reviews use. An empty choice means the provider's
 * default; otherwise the model must be one the key can use right now.
 */
export const saveReviewModel = (
  access: SessionAccess,
  workspaceId: number,
  rawModel: string,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_settings",
    );

    const model = rawModel.trim();

    if (model !== "") {
      if (!MODEL_ID.test(model)) {
        return yield* new ModelNotAllowedError({ model });
      }

      const key = yield* decryptWorkspaceKey(viewer.workspace, encryptionKey);

      const checker = yield* ReviewKeyChecker;

      const models = yield* checker
        .listModels(key.provider, key.apiKey)
        .pipe(Effect.mapError(() => new ReviewKeyCheckUnavailableError()));

      if (Option.isNone(models) || !models.value.includes(model)) {
        return yield* new ModelNotAllowedError({ model });
      }
    }

    yield* WorkspaceRepository.saveReviewModelWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousModel: viewer.workspace.reviewModel,
      model: model === "" ? null : model,
    });
  });

/**
 * Sets the paid plan's model: a catalog model the plan offers, whose
 * provider has a platform key configured. Empty means the plan default.
 */
export const savePlanModel = (
  access: SessionAccess,
  workspaceId: number,
  rawModel: string,
  platformVendors: ReadonlySet<ModelVendor>,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_settings",
    );

    const model = rawModel.trim();

    if (model !== "") {
      const known = findCatalogModel(model);

      if (
        known === undefined ||
        !isPlanModel(known) ||
        !platformVendors.has(known.vendor)
      ) {
        return yield* new ModelNotAllowedError({ model });
      }
    }

    yield* WorkspaceRepository.savePlanModelWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousModel: viewer.workspace.planModel,
      model: model === "" ? null : model,
    });
  });

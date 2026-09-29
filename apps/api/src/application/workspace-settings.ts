import { Context, Data, Effect, Layer, Option } from "effect";
import {
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import { checkGeminiKey } from "@not-quite-my-tempo/gemini";
import type {
  GeminiProvider,
  GeminiRequestError,
} from "@not-quite-my-tempo/gemini";

import { encryptToken } from "../auth/token-cipher.js";
import { logInfo } from "../logging.js";
import { authorizeWorkspace } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";

/** Platform-key reviews every workspace gets before it needs its own key. */
export const FREE_TRIAL_REVIEWS = 5;

/** Encryption context binding a stored Gemini key to its workspace. */
export const geminiKeyContext = (workspaceId: number) =>
  `workspace:${workspaceId}:gemini`;

export class InvalidGeminiKeyError extends Data.TaggedError(
  "InvalidGeminiKeyError",
)<{
  readonly reason: "format" | "rejected";
}> {}

export class GeminiUnavailableError extends Data.TaggedError(
  "GeminiUnavailableError",
) {}

export interface GeminiKeyCheckerService {
  /** The Google API that accepts the key, or None when both reject it. */
  readonly check: (
    apiKey: string,
  ) => Effect.Effect<Option.Option<GeminiProvider>, GeminiRequestError>;
}

export class GeminiKeyChecker extends Context.Tag(
  "@not-quite-my-tempo/api/GeminiKeyChecker",
)<GeminiKeyChecker, GeminiKeyCheckerService>() {}

export const GeminiKeyCheckerLive = Layer.succeed(
  GeminiKeyChecker,
  GeminiKeyChecker.of({ check: (apiKey) => checkGeminiKey(apiKey) }),
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

    return {
      workspace: viewer.workspace,
      viewerRole: viewer.role,
      trial: trialStatus(usage?.used ?? 0),
    };
  });

// Only catches paste mistakes (whitespace, quotes, a whole
// "GEMINI_API_KEY=..." line) before any network call; Google decides
// whether the key is valid. Keys come in more than one format: classic
// "AIza..." keys and newer ones that contain "." and are longer.
const KEY_PATTERN = /^[A-Za-z0-9._~+/-]{20,512}$/;

/**
 * Checks the key with Gemini, then stores it encrypted. A key Gemini
 * rejects, or couldn't check, is never stored.
 */
export const saveGeminiKey = (
  access: SessionAccess,
  workspaceId: number,
  rawKey: string,
  encryptionKey: string | undefined,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_settings",
    );

    const apiKey = rawKey.trim();

    if (!KEY_PATTERN.test(apiKey)) {
      return yield* new InvalidGeminiKeyError({ reason: "format" });
    }

    const checker = yield* GeminiKeyChecker;

    const provider = yield* checker
      .check(apiKey)
      .pipe(Effect.mapError(() => new GeminiUnavailableError()));

    if (Option.isNone(provider)) {
      return yield* new InvalidGeminiKeyError({ reason: "rejected" });
    }

    const ciphertext = yield* encryptToken(
      encryptionKey,
      apiKey,
      geminiKeyContext(workspaceId),
    );

    yield* WorkspaceRepository.saveGeminiKeyWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousLast4: viewer.workspace.geminiKeyLast4,
      ciphertext,
      last4: apiKey.slice(-4),
      provider: provider.value,
    });

    yield* logInfo("gemini_key_saved", {
      workspaceId,
      actorUserId: access.userId,
      provider: provider.value,
    });
  });

export const removeGeminiKey = (access: SessionAccess, workspaceId: number) =>
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

    yield* WorkspaceRepository.removeGeminiKeyWithAudit({
      workspaceId,
      actorUserId: access.userId,
      previousLast4: viewer.workspace.geminiKeyLast4,
    });

    yield* logInfo("gemini_key_removed", {
      workspaceId,
      actorUserId: access.userId,
    });
  });

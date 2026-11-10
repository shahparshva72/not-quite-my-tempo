import { Schema, Effect } from "effect";

export const ReviewSeverityThreshold = Schema.Literals([
  "critical",
  "warning",
  "suggestion",
]);

export type ReviewSeverityThreshold = typeof ReviewSeverityThreshold.Type;

export const ReviewIntensity = Schema.Literals([
  "sectional",
  "studio_band",
  "carnegie",
]);

export type ReviewIntensity = typeof ReviewIntensity.Type;

/**
 * How Fletcher phrases the review. Orthogonal to {@link ReviewIntensity}:
 * tone changes the wording only, never which findings are raised or how
 * severe they are.
 */
export const ReviewTone = Schema.Literals(["standard", "ruthless"]);

export type ReviewTone = typeof ReviewTone.Type;

/**
 * Per-repository configuration read from `.fletcher.json` on the
 * repository's default branch (never the pull request, whose author could
 * otherwise turn the review off). Every field is optional; a missing or malformed file
 * must resolve to {@link defaultReviewConfig}, never fail a review.
 */
export const ReviewConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  severityThreshold: ReviewSeverityThreshold.pipe(
    Schema.withDecodingDefault(Effect.succeed("suggestion" as const)),
  ),
  ignore: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  intensity: ReviewIntensity.pipe(
    Schema.withDecodingDefault(Effect.succeed("studio_band" as const)),
  ),
  tone: ReviewTone.pipe(
    Schema.withDecodingDefault(Effect.succeed("standard" as const)),
  ),
  /**
   * Paths or globs of the files that hold the repository's review
   * guidelines, read from the default branch. Null means the usual
   * locations (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, …).
   */
  guidelines: Schema.NullOr(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});

export type ReviewConfig = typeof ReviewConfig.Type;

export const defaultReviewConfig: ReviewConfig = {
  enabled: true,
  severityThreshold: "suggestion",
  ignore: [],
  intensity: "studio_band",
  tone: "standard",
  guidelines: null,
};

export const REVIEW_CONFIG_PATH = ".fletcher.json";

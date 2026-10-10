import { Schema } from "effect";

export const ReviewSeverityThreshold = Schema.Literal(
  "critical",
  "warning",
  "suggestion",
);

export type ReviewSeverityThreshold = typeof ReviewSeverityThreshold.Type;

export const ReviewIntensity = Schema.Literal(
  "sectional",
  "studio_band",
  "carnegie",
);

export type ReviewIntensity = typeof ReviewIntensity.Type;

/**
 * How Fletcher phrases the review. Orthogonal to {@link ReviewIntensity}:
 * tone changes the wording only, never which findings are raised or how
 * severe they are.
 */
export const ReviewTone = Schema.Literal("standard", "ruthless");

export type ReviewTone = typeof ReviewTone.Type;

/**
 * Per-repository configuration read from `.fletcher.json` on the
 * repository's default branch (never the pull request, whose author could
 * otherwise turn the review off). Every field is optional; a missing or malformed file
 * must resolve to {@link defaultReviewConfig}, never fail a review.
 */
export const ReviewConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  severityThreshold: Schema.optionalWith(ReviewSeverityThreshold, {
    default: () => "suggestion" as const,
  }),
  ignore: Schema.optionalWith(Schema.Array(Schema.String), {
    default: (): readonly string[] => [],
  }),
  intensity: Schema.optionalWith(ReviewIntensity, {
    default: () => "studio_band" as const,
  }),
  tone: Schema.optionalWith(ReviewTone, {
    default: () => "standard" as const,
  }),
  /**
   * Paths or globs of the files that hold the repository's review
   * guidelines, read from the default branch. Null means the usual
   * locations (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, …).
   */
  guidelines: Schema.optionalWith(Schema.NullOr(Schema.Array(Schema.String)), {
    default: () => null,
  }),
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

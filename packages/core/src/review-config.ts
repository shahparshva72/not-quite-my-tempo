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
 * Per-repository configuration read from `.fletcher.json` at the pull
 * request's head SHA. Every field is optional; a missing or malformed file
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
});

export type ReviewConfig = typeof ReviewConfig.Type;

export const defaultReviewConfig: ReviewConfig = {
  enabled: true,
  severityThreshold: "suggestion",
  ignore: [],
  intensity: "studio_band",
};

export const REVIEW_CONFIG_PATH = ".fletcher.json";

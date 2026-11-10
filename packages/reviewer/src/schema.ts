import { Schema } from "effect";

export const FindingSeverity = Schema.Literals([
  "critical",
  "warning",
  "suggestion",
]);

export type FindingSeverity = typeof FindingSeverity.Type;

export const ReviewVerdict = Schema.Literals([
  "not_my_tempo",
  "almost",
  "good_job",
]);

export type ReviewVerdict = typeof ReviewVerdict.Type;

export const GeminiFinding = Schema.Struct({
  filePath: Schema.NonEmptyString,
  line: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  severity: FindingSeverity,
  category: Schema.NullOr(Schema.String),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  title: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
});

export type GeminiFinding = typeof GeminiFinding.Type;

export const GeminiReview = Schema.Struct({
  verdict: ReviewVerdict,
  summary: Schema.NonEmptyString,
  findings: Schema.Array(GeminiFinding),
});

export type GeminiReview = typeof GeminiReview.Type;

const severityRank: Record<FindingSeverity, number> = {
  critical: 3,
  warning: 2,
  suggestion: 1,
};

export const verdictForFindings = (
  findings: readonly GeminiFinding[],
): ReviewVerdict => {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "not_my_tempo";
  }

  return findings.some((finding) => finding.severity === "warning")
    ? "almost"
    : "good_job";
};

/**
 * Drops findings below the configured severity threshold and derives the
 * verdict from those kept. The model's summary stays unless no findings
 * remain, when it would describe allegations nobody can see.
 */
export const filterReviewBySeverity = (
  review: GeminiReview,
  threshold: FindingSeverity,
): GeminiReview => {
  const findings = review.findings.filter(
    (finding) => severityRank[finding.severity] >= severityRank[threshold],
  );

  return {
    ...review,
    findings,
    verdict: verdictForFindings(findings),
    summary:
      findings.length === 0 && review.findings.length > 0
        ? "No findings remain at the configured severity threshold."
        : review.summary,
  };
};

/**
 * The response schema sent to Gemini's `generationConfig.responseSchema` so
 * structured output decodes directly into {@link GeminiReview}. Kept in sync
 * with the Effect schemas above by the golden test in
 * `apps/api/test/gemini-reviewer.test.ts`.
 */
export const geminiResponseJsonSchema = {
  type: "OBJECT",
  properties: {
    verdict: {
      type: "STRING",
      enum: ["not_my_tempo", "almost", "good_job"],
    },
    summary: { type: "STRING" },
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          filePath: { type: "STRING" },
          line: { type: "INTEGER", nullable: true },
          severity: {
            type: "STRING",
            enum: ["critical", "warning", "suggestion"],
          },
          category: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" },
          title: { type: "STRING" },
          message: { type: "STRING" },
        },
        required: [
          "filePath",
          "line",
          "severity",
          "category",
          "confidence",
          "title",
          "message",
        ],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
} as const;

const findingProperties = {
  filePath: { type: "string" },
  line: { type: ["integer", "null"] },
  severity: { type: "string", enum: ["critical", "warning", "suggestion"] },
  category: { type: ["string", "null"] },
  confidence: { type: "number" },
  title: { type: "string" },
  message: { type: "string" },
} as const;

/**
 * The same review shape as standard JSON Schema, for OpenAI's strict
 * structured outputs and Anthropic's tool input schema. Strict mode needs
 * every property required and no extra properties, and rejects keywords
 * such as minLength, so {@link GeminiReview}'s refinements are applied
 * after decoding instead.
 */
export const reviewJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["not_my_tempo", "almost", "good_job"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: findingProperties,
        required: Object.keys(findingProperties),
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

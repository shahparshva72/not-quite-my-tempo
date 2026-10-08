import { Schema } from "effect";

export const FindingSeverity = Schema.Literal(
  "critical",
  "warning",
  "suggestion",
);

export type FindingSeverity = typeof FindingSeverity.Type;

export const ReviewVerdict = Schema.Literal(
  "not_my_tempo",
  "almost",
  "good_job",
);

export type ReviewVerdict = typeof ReviewVerdict.Type;

export const GeminiFinding = Schema.Struct({
  filePath: Schema.NonEmptyString,
  line: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
  severity: FindingSeverity,
  category: Schema.NullOr(Schema.String),
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
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

/**
 * Drops findings below the configured severity threshold. The verdict and
 * summary are left untouched — the model already weighed everything; the
 * threshold only controls what gets persisted and posted.
 */
export const filterReviewBySeverity = (
  review: GeminiReview,
  threshold: FindingSeverity,
): GeminiReview => ({
  ...review,
  findings: review.findings.filter(
    (finding) => severityRank[finding.severity] >= severityRank[threshold],
  ),
});

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

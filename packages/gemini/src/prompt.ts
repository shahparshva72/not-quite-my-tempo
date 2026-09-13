import { Match } from "effect";

import type { FindingSeverity } from "./schema.js";

// Mirrors ReviewIntensity in @not-quite-my-tempo/core (kept dependency-free).
export type ReviewIntensity = "sectional" | "studio_band" | "carnegie";

export interface PriorFinding {
  readonly filePath: string;
  readonly line: number | null;
  readonly severity: FindingSeverity;
  readonly title: string | null;
  readonly message: string;
}

export interface PriorReview {
  readonly headSha: string;
  readonly findings: readonly PriorFinding[];
}

export interface GeminiReviewInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly body: string | null;
  readonly diff: string;
  readonly priorReview: PriorReview | null;
  readonly intensity: ReviewIntensity;
}

export const FLETCHER_SYSTEM_PROMPT = `You are "Fletcher", a legendarily \
demanding code reviewer modeled on a ruthless conservatory band instructor. \
You review pull requests the way he rehearses a studio band: nothing sloppy \
survives, nothing mediocre gets praised, and excellence is acknowledged \
grudgingly and rarely.

VOICE
- Terse, cutting, impatient with sloppiness. Theatrical exasperation is
  allowed; profanity is not.
- Remix the persona's phrasing sparingly ("not quite my tempo", "were you
  rushing or were you dragging?", "that's not your job"). Never repeat the
  same catchphrase twice in one review.
- The persona is seasoning. The substance is the review. Every sentence must
  carry technical weight.

HARD RULES — NEVER VIOLATE
- Critique the CODE, never the author as a person. No insults directed at
  people, no slurs, no comments about ability or intelligence.
- Every finding must contain a concrete, technically correct fix or a precise
  question. If you cannot say what to do instead, do not raise the finding.
- Do not fabricate problems to stay in character. A clean pull request gets
  the verdict "good_job" and a short, grudging acknowledgment.

REVIEW RUBRIC
- Only comment on lines changed in the diff (added lines). Do not review
  unchanged context.
- Prefer a few high-signal findings over volume. Ten nitpicks are noise; two
  real defects are a review.
- Severity honesty: "critical" is reserved for correctness, security, or
  data-loss defects. Style and taste are "suggestion". Everything between is
  "warning".
- Calibrate "confidence" between 0 and 1 honestly: 0.9+ means you would stake
  the take on it; below 0.5 means you are raising a question, and the message
  must be phrased as one.
- "line" must be a line number from the NEW version of the file, taken from
  the diff. Use null only for file-level findings.

MEMORY
- When a previous review is provided, you reviewed an earlier commit of this
  same pull request. Compare it against the current diff.
- Findings that are fixed: acknowledge them in the summary in one clipped,
  grudging clause. Do not list them as findings.
- Findings that are unchanged and still visible in the diff: re-raise them
  once, escalated — raise the severity one level (suggestion → warning,
  warning → critical) and note this is the second time.
- Never re-raise a prior finding whose code no longer appears in the diff.

VERDICT
- "not_my_tempo": at least one critical finding, or the change is broadly
  sloppy.
- "almost": no criticals, but real warnings remain.
- "good_job": nothing worth flagging. Say so in one or two clipped sentences.

OUTPUT
- Respond only with JSON matching the provided response schema.
- "summary" is the review opening: 2-5 sentences, persona voice, an honest
  overall assessment of the change.`;

const intensitySection = (intensity: ReviewIntensity): string =>
  Match.value(intensity).pipe(
    Match.when(
      "sectional",
      () => `\n\nINTENSITY: sectional rehearsal. Dial the persona down: dry,
curt, and businesslike. No theatrics, no catchphrases — just the findings
and the verdict.`,
    ),
    Match.when("studio_band", () => ""),
    Match.when(
      "carnegie",
      () => `\n\nINTENSITY: Carnegie. This is the performance. Hold the diff
to the highest standard you can technically justify: scrutinize naming,
edge cases, and tests. "good_job" requires a flawless change. The hard
rules still apply — escalated standards, never fabricated findings.`,
    ),
    Match.exhaustive,
  );

export const buildSystemPrompt = (intensity: ReviewIntensity): string =>
  `${FLETCHER_SYSTEM_PROMPT}${intensitySection(intensity)}`;

const priorFindingLine = (finding: PriorFinding) => {
  const location =
    finding.line === null
      ? finding.filePath
      : `${finding.filePath}:${finding.line}`;

  const title = finding.title === null ? "" : `${finding.title} — `;

  return `- ${location} [${finding.severity}] ${title}${finding.message}`;
};

const priorReviewSection = (priorReview: PriorReview | null) => {
  if (priorReview === null) {
    return "";
  }

  if (priorReview.findings.length === 0) {
    return `\n\nPrevious review (commit ${priorReview.headSha}): no findings\nwere raised. If this push introduced new problems, say so.`;
  }

  return `\n\nPrevious review (commit ${priorReview.headSha}) raised these\nfindings. Apply the MEMORY rules:\n${priorReview.findings
    .map(priorFindingLine)
    .join("\n")}`;
};

export const buildReviewUserPrompt = (input: GeminiReviewInput) => {
  const description =
    input.body === null || input.body === ""
      ? "(no description provided — noted.)"
      : input.body;

  return `Review this pull request.

Repository: ${input.repository}
Pull request: #${input.pullRequestNumber}
Title: ${input.title}

Description:
${description}${priorReviewSection(input.priorReview)}

Unified diff:
\`\`\`diff
${input.diff}
\`\`\``;
};

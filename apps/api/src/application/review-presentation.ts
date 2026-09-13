import { Match } from "effect";
import type { Finding } from "@not-quite-my-tempo/db";
import type { GeminiReview, ReviewVerdict } from "@not-quite-my-tempo/gemini";

export const verdictHeading = (verdict: ReviewVerdict): string =>
  Match.value(verdict).pipe(
    Match.when("not_my_tempo", () => "🥁 Not quite my tempo."),
    Match.when("almost", () => "🥁 Almost. Almost."),
    Match.when("good_job", () => "🥁 ...Good job."),
    Match.exhaustive,
  );

export const buildFindingCommentBody = (finding: Finding): string => {
  const heading = finding.title === null ? "" : `**${finding.title}**\n\n`;

  const confidence =
    finding.confidence === null
      ? ""
      : ` · confidence ${finding.confidence.toFixed(2)}`;

  return `${heading}${finding.message}\n\n_severity: ${finding.severity}${confidence}_`;
};

const severityCountLine = (findings: readonly Finding[]): string => {
  const counts = { critical: 0, warning: 0, suggestion: 0 };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return `**${findings.length}** finding(s) — ${counts.critical} critical, ${counts.warning} warning, ${counts.suggestion} suggestion.`;
};

const unanchoredSection = (unanchored: readonly Finding[]): string => {
  if (unanchored.length === 0) {
    return "";
  }

  const items = unanchored.map((finding) => {
    const title = finding.title === null ? finding.message : finding.title;

    const location =
      finding.line === null
        ? `\`${finding.filePath}\``
        : `\`${finding.filePath}:${finding.line}\``;

    return `- ${location} — ${title} (_${finding.severity}_)\n  ${finding.message}`;
  });

  return `\n\n#### Off the chart (couldn't anchor these to the diff)\n\n${items.join("\n")}`;
};

export const buildReviewSummaryBody = (
  review: GeminiReview,
  findings: readonly Finding[],
  unanchored: readonly Finding[],
): string =>
  `### ${verdictHeading(review.verdict)}

${review.summary}

${severityCountLine(findings)}${unanchoredSection(unanchored)}`;

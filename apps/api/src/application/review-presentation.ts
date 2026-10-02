import { Match } from "effect";
import type { Finding } from "@not-quite-my-tempo/db";
import type {
  GeminiReview,
  ReviewTone,
  ReviewVerdict,
} from "@not-quite-my-tempo/gemini";

const standardHeading = (verdict: ReviewVerdict): string =>
  Match.value(verdict).pipe(
    Match.when("not_my_tempo", () => "🥁 Not quite my tempo."),
    Match.when("almost", () => "🥁 Almost. Almost."),
    Match.when("good_job", () => "🥁 ...Good job."),
    Match.exhaustive,
  );

// Ruthless Fletcher never says "good job".
const ruthlessHeading = (verdict: ReviewVerdict): string =>
  Match.value(verdict).pipe(
    Match.when("not_my_tempo", () => "🥁 Not. Quite. My. Tempo."),
    Match.when("almost", () => "🥁 Were you rushing or were you dragging?"),
    Match.when("good_job", () => "🥁 ...Acceptable."),
    Match.exhaustive,
  );

export const verdictHeading = (
  verdict: ReviewVerdict,
  tone: ReviewTone,
): string =>
  Match.value(tone).pipe(
    Match.when("standard", () => standardHeading(verdict)),
    Match.when("ruthless", () => ruthlessHeading(verdict)),
    Match.exhaustive,
  );

// Code spans and fences, which are shown literally and left untouched.
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/;

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;

const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g;

const LINK_DEFINITION = /^(\s{0,3})\[([^\]]+)\]:/gm;

const LINKING_HTML = /<\/?(?:a|img|picture|source|video|audio)\b[^>]*>/gi;

/**
 * Model text is shaped by the pull request it reviews, so a diff can steer
 * it. Before Fletcher posts it under its own name, links show where they
 * go and nothing loads from elsewhere: images become their alt text,
 * `[text](url)` becomes `text (url)`, and link/image HTML tags are dropped.
 * Code is left as written.
 */
export const defangModelMarkdown = (text: string): string =>
  text
    .split(CODE_SEGMENT)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment
            .replace(MARKDOWN_IMAGE, "$1")
            .replace(MARKDOWN_LINK, (_match, label: string, url: string) =>
              url === "" ? label : `${label} (${url})`,
            )
            .replace(LINK_DEFINITION, "$1\\[$2]:")
            .replace(LINKING_HTML, ""),
    )
    .join("");

// A file path shown in a code span; a backtick in it would end the span.
const codePath = (path: string) => path.replaceAll("`", "'");

export const buildFindingCommentBody = (finding: Finding): string => {
  const heading =
    finding.title === null
      ? ""
      : `**${defangModelMarkdown(finding.title)}**\n\n`;

  const confidence =
    finding.confidence === null
      ? ""
      : ` · confidence ${finding.confidence.toFixed(2)}`;

  return `${heading}${defangModelMarkdown(finding.message)}\n\n_severity: ${finding.severity}${confidence}_`;
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
    const title = defangModelMarkdown(
      finding.title === null ? finding.message : finding.title,
    );

    const location =
      finding.line === null
        ? `\`${codePath(finding.filePath)}\``
        : `\`${codePath(finding.filePath)}:${finding.line}\``;

    return `- ${location} — ${title} (_${finding.severity}_)\n  ${defangModelMarkdown(finding.message)}`;
  });

  return `\n\n#### Off the chart (couldn't anchor these to the diff)\n\n${items.join("\n")}`;
};

export const buildReviewSummaryBody = (
  review: GeminiReview,
  findings: readonly Finding[],
  unanchored: readonly Finding[],
  tone: ReviewTone,
): string =>
  `### ${verdictHeading(review.verdict, tone)}

${defangModelMarkdown(review.summary)}

${severityCountLine(findings)}${unanchoredSection(unanchored)}`;

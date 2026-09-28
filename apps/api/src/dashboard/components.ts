import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FindingSeverity, GitHubRepository } from "@not-quite-my-tempo/db";

import { FONTS_HREF, styles } from "./theme.js";

export type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

const accountArea = (login: string | null) =>
  login === null
    ? html`<a class="link-button" href="/auth/login">Sign in</a>`
    : html`<div class="account">
        <span>Signed in as ${login}</span>
        <form method="post" action="/auth/logout">
          <button class="link-button" type="submit">Sign out</button>
        </form>
      </div>`;

/**
 * Page shell. `login` is the signed-in GitHub login, or null on public
 * pages; it decides whether the top bar offers sign-in or sign-out.
 */
export const layout = (
  title: string,
  login: string | null,
  content: HtmlContent,
) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="dark" />
      <title>${title} | Not Quite My Tempo</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link rel="stylesheet" href="${FONTS_HREF}" />
      <style>
        ${raw(styles)}
      </style>
    </head>
    <body>
      <header class="bar">
        <a class="wordmark" href="${login === null ? "/" : "/dashboard"}">
          Not Quite My Tempo
        </a>
        ${accountArea(login)}
      </header>
      <main>${content}</main>
    </body>
  </html>`;

const severityMarks: Record<FindingSeverity, string> = {
  critical: "ff",
  warning: "mf",
  suggestion: "p",
};

const severityNames: Record<FindingSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  suggestion: "Suggestion",
};

/** Severity as a dynamic mark (ff / mf / p) with its name for screen readers. */
export const dynamicMark = (severity: FindingSeverity) =>
  html`<span class="dyn dyn-${severity}" title="${severityNames[severity]}"
    ><span aria-hidden="true">${severityMarks[severity]}</span
    ><span class="visually-hidden">${severityNames[severity]}</span></span
  >`;

/** A boxed rehearsal mark labeling one step of an ordered sequence. */
export const rehearsalStep = (
  mark: string,
  done: boolean,
  content: HtmlContent,
) =>
  html`<li class="step${done ? " step-done" : ""}">
    <span class="mark" aria-hidden="true">${mark}</span>
    <div>${content}</div>
  </li>`;

/**
 * Review on/off control. A real form post, so it works without JavaScript;
 * the button is a switch whose accessible name is the repository.
 */
export const reviewSwitch = (
  repository: GitHubRepository,
  returnTo: "onboarding" | "repository",
) =>
  html`<form method="post" action="/onboarding/repositories/${repository.id}">
    <input type="hidden" name="return" value="${returnTo}" />
    <input
      type="hidden"
      name="enabled"
      value="${repository.enabled ? "false" : "true"}"
    />
    <button
      class="switch"
      type="submit"
      role="switch"
      aria-checked="${repository.enabled ? "true" : "false"}"
      aria-label="Reviews for ${repository.fullName}"
    >
      <span>${repository.enabled ? "Reviews on" : "Reviews off"}</span>
      <span class="track" aria-hidden="true"></span>
    </button>
  </form>`;

/**
 * The review switch for admins and owners; for members, the current state
 * and who can change it (members can't turn reviews on or off).
 */
export const reviewControl = (
  repository: GitHubRepository,
  canToggle: boolean,
  returnTo: "onboarding" | "repository",
) =>
  canToggle
    ? reviewSwitch(repository, returnTo)
    : html`<span class="review-state"
        >${repository.enabled ? "Reviews on" : "Reviews off"}
        <span class="quiet">Ask an admin to change this</span></span
      >`;

/** One headline, one explanation, one action. */
export const messagePage = (
  title: string,
  login: string | null,
  body: HtmlContent,
) =>
  layout(
    title,
    login,
    html`<div class="message">
      <h1 class="page-title">${title}</h1>
      ${body}
    </div>`,
  );

const failureReasons = new Map<string, string>([
  [
    "github_auth_error",
    "Fletcher couldn't sign in to GitHub for this repository",
  ],
  ["diff_fetch_error", "GitHub didn't send the pull request's changes"],
  ["diff_too_large", "the pull request is too large to review"],
  ["post_review_error", "GitHub didn't accept the review comments"],
  ["gemini_error", "the Gemini API didn't return a review"],
  ["db_error", "a storage error on our side"],
  ["review_run_not_found", "a storage error on our side"],
]);

/** Why a review failed, in words a repository owner can act on. */
export const failureReason = (errorCode: string | null) =>
  failureReasons.get(errorCode ?? "") ?? "an unexpected error on our side";

const triggerLabels = new Map<string, string>([
  ["opened", "Opened"],
  ["synchronize", "New push"],
  ["reopened", "Reopened"],
  ["manual", "Asked again"],
]);

export const triggerLabel = (trigger: string) =>
  triggerLabels.get(trigger) ?? trigger;

const numberFormat = new Intl.NumberFormat("en-US");

export const formatNumber = (value: number) => numberFormat.format(value);

const plural = (value: number, unit: string) =>
  `${value} ${unit}${value === 1 ? "" : "s"} ago`;

/**
 * "just now", "5 minutes ago", "3 days ago"; older than 30 days falls back
 * to the date. The exact time stays available in the title attribute.
 */
export const relativeTime = (date: Date, now: Date) => {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);

  const label =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? plural(minutes, "minute")
        : minutes < 60 * 24
          ? plural(Math.floor(minutes / 60), "hour")
          : minutes < 60 * 24 * 30
            ? plural(Math.floor(minutes / (60 * 24)), "day")
            : date.toISOString().slice(0, 10);

  return html`<time
    datetime="${date.toISOString()}"
    title="${date.toISOString().replace("T", " ").slice(0, 16)} UTC"
    >${label}</time
  >`;
};

export interface ReviewCounts {
  readonly critical: number;
  readonly warning: number;
  readonly suggestion: number;
}

const countPhrase = (counts: ReviewCounts) =>
  [
    counts.critical > 0 ? `${counts.critical} critical` : null,
    counts.warning > 0
      ? `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`
      : null,
    counts.suggestion > 0
      ? `${counts.suggestion} suggestion${counts.suggestion === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

const loudest = (counts: ReviewCounts): FindingSeverity | null =>
  counts.critical > 0
    ? "critical"
    : counts.warning > 0
      ? "warning"
      : counts.suggestion > 0
        ? "suggestion"
        : null;

export interface ReviewOutcomeRun {
  readonly status: string;
  readonly model: string | null;
  readonly errorCode: string | null;
}

/**
 * The mark column and one-line result for a review: its loudest finding as
 * a dynamic mark plus counts, or the run's state in plain words.
 */
export const reviewOutcome = (run: ReviewOutcomeRun, counts: ReviewCounts) => {
  // Only a finished review has a verdict worth marking.
  const mark =
    run.status === "completed" && run.model !== null ? loudest(counts) : null;

  const text =
    run.status === "queued" || run.status === "running"
      ? html`<span class="state-active">Reviewing now</span>`
      : run.status === "failed"
        ? html`<span class="state-failed"
            >Failed: ${failureReason(run.errorCode)}</span
          >`
        : run.status === "cancelled"
          ? html`<span class="quiet">Cancelled</span>`
          : run.model === null
            ? html`<span class="quiet">Skipped by .fletcher.json</span>`
            : mark === null
              ? html`<span>No findings</span>`
              : html`<span>${countPhrase(counts)}</span>`;

  return {
    mark: mark === null ? html`` : dynamicMark(mark),
    text,
  };
};

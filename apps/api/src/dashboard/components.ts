import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FindingSeverity, GitHubRepository } from "@not-quite-my-tempo/db";

import { FONTS_HREF, styles } from "./theme.js";

export type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

// Stroke icons, 24px grid, drawn in currentColor.
const iconPaths = {
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  external:
    '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  message:
    '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
  pullRequest:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3.5L10.5 6 13 8.5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  repo: '<path d="M5 19V5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h12"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
} as const;

export type IconName = keyof typeof iconPaths;

export const icon = (name: IconName) =>
  raw(
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`,
  );

const githubMark = raw(
  '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
);

/** The GitHub mark followed by a label, for sign-in and install links. */
export const withGitHub = (label: string) => html`${githubMark} ${label}`;

// A metronome: the product's mark in the logo tile.
const logoMark = raw(
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 3h7l4 18h-15z"/><path d="M12 16l5-10"/><path d="M6.5 16h11"/></svg>',
);

export const logo = html`<span class="logo">${logoMark}</span>`;

/** A GitHub avatar over the login's initial, which shows if it can't load. */
export const avatar = (login: string, large = false) =>
  html`<span class="avatar${large ? " avatar-lg" : ""}" aria-hidden="true"
    >${login.slice(0, 1)}<img
      src="https://avatars.githubusercontent.com/${login}?size=${large ? 80 : 56}"
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
  /></span>`;

export type NavItem = "repositories" | "setup";

const navLink = (href: string, label: string, current: boolean) =>
  html`<a href="${href}" ${current ? raw('aria-current="page"') : ""}
    >${label}</a
  >`;

const accountArea = (login: string | null) =>
  login === null
    ? html`<div class="account-public">
        <a class="btn btn-ghost btn-sm" href="/auth/login">Sign in</a>
        <a class="btn btn-sm" href="/auth/login">Get started</a>
      </div>`
    : html`<div class="account">
        <span class="who"
          >${avatar(login)}<span>Signed in as ${login}</span></span
        >
        <form method="post" action="/auth/logout">
          <button class="btn btn-secondary btn-sm" type="submit">
            Sign out
          </button>
        </form>
      </div>`;

const navigation = (login: string | null, active: NavItem | null) =>
  login === null
    ? html`<nav class="nav" aria-label="Site">
        <a href="/#how" class="hide-sm">How it works</a>
        <a href="/#pricing">Pricing</a>
        <a href="/#privacy" class="hide-sm">Privacy</a>
      </nav>`
    : html`<nav class="nav" aria-label="Main">
        ${navLink("/dashboard", "Repositories", active === "repositories")}
        ${navLink("/onboarding", "Setup", active === "setup")}
      </nav>`;

/**
 * Page shell. `login` is the signed-in GitHub login, or null on public
 * pages; it decides whether the top bar offers sign-in or sign-out.
 * `active` marks the current section in the top bar's navigation.
 */
export const layout = (
  title: string,
  login: string | null,
  content: HtmlContent,
  active: NavItem | null = null,
) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="dark" />
      <meta name="theme-color" content="#0e1c1c" />
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
        <div class="shell bar-inner">
          <a class="wordmark" href="${login === null ? "/" : "/dashboard"}">
            ${logo}<span class="wordmark-text">Not Quite My Tempo</span>
          </a>
          ${navigation(login, active)} ${accountArea(login)}
        </div>
      </header>
      <main><div class="shell">${content}</div></main>
      <footer class="footer">
        <div class="shell footer-inner">
          <p>Not Quite My Tempo. Code review from Fletcher.</p>
          <nav aria-label="Footer">
            <a href="/#how">How it works</a>
            <a href="/#pricing">Pricing</a>
            <a href="/#privacy">Privacy</a>
          </nav>
        </div>
      </footer>
    </body>
  </html>`;

/** Page heading with an optional line under it and actions on the right. */
export const pageHead = (
  title: HtmlContent | string,
  subtitle: HtmlContent | string | null,
  actions: HtmlContent | string = "",
) =>
  html`<div class="page-head">
    <div>
      <h1 class="page-title">${title}</h1>
      ${subtitle === null ? "" : html`<p class="quiet">${subtitle}</p>`}
    </div>
    ${actions}
  </div>`;

/** Breadcrumb trail; the last entry is the current page and isn't a link. */
export const crumbs = (
  trail: readonly (readonly [href: string, label: string])[],
  current: string,
) =>
  html`<nav aria-label="Breadcrumb">
    <p class="crumbs">
      ${trail.map(
        ([href, label]) =>
          html`<a href="${href}">${label}</a
            ><span class="sep" aria-hidden="true">/</span>`,
      )}<span aria-current="page">${current}</span>
    </p>
  </nav>`;

/** Whether reviews are on for a repository, as a badge. */
export const reviewsBadge = (enabled: boolean) =>
  enabled
    ? html`<span class="badge badge-dot badge-on">Reviews on</span>`
    : html`<span class="badge badge-dot">Reviews off</span>`;

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
        >${reviewsBadge(repository.enabled)}
        <span class="fine">Ask an admin to change this</span></span
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
    html`<div class="card message">
      ${logo}
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
  [
    "no_gemini_key",
    "this workspace has no Gemini key and its free reviews are used up",
  ],
  ["gemini_key_rejected", "Google rejected this workspace's Gemini key"],
  ["stuck", "the review stopped before finishing"],
  [
    "gemini_key_unreadable",
    "the saved Gemini key couldn't be read; an admin needs to save it again",
  ],
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
 * a dynamic mark plus counts, or the run's state in plain words. Without a
 * mark, the column holds a neutral dot so rows stay aligned.
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
    mark:
      mark === null
        ? html`<span class="dot" aria-hidden="true"></span>`
        : dynamicMark(mark),
    text,
  };
};

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
export const reviewSwitch = (repository: GitHubRepository) =>
  html`<form method="post" action="/onboarding/repositories/${repository.id}">
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

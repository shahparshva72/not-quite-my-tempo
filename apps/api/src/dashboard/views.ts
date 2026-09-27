import { html } from "hono/html";
import type {
  Finding,
  GitHubRepository,
  ReviewRun,
} from "@not-quite-my-tempo/db";

import type {
  RepositoryOverview,
  ReviewSummary,
} from "../application/read-api.js";
import {
  dynamicMark,
  formatNumber,
  layout,
  messagePage,
  rehearsalStep,
  relativeTime,
  reviewOutcome,
  reviewSwitch,
  triggerLabel,
} from "./components.js";

const sampleReview = html`<figure class="sample">
  <figcaption class="fine">
    <strong class="code">src/tempo.ts</strong> in pull request 42
  </figcaption>
  <pre><span class="ln">12</span>export const beatLength = (bar: Bar) =&gt; {
<span class="ln">13</span>  const beats = bar.signature.beats;
<span class="ln">14</span>  <span class="flagged">return bar.duration / beats;<svg class="pencil" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><ellipse cx="50" cy="20" rx="48" ry="17" transform="rotate(-2 50 20)" /></svg></span>
<span class="ln">15</span>};</pre>
  <div class="annotation">
    ${dynamicMark("critical")}
    <div>
      <p><strong>Were you rushing or were you dragging?</strong></p>
      <p>
        A 0/4 signature divides by zero here. Reject a bar with no beats before
        you divide.
      </p>
    </div>
  </div>
</figure>`;

export const landingPage = () =>
  layout(
    "Code review from Fletcher",
    null,
    html`<div class="hero">
        <div>
          <h1 class="headline">
            <span class="on-staff">Not quite my tempo.</span>
          </h1>
          <p class="lede">
            Fletcher reviews every pull request you open. He marks what's wrong
            on the exact line and tells you how to fix it. He is not gentle, but
            he is right.
          </p>
          <a class="btn" href="/auth/login">Sign in with GitHub</a>
          <p class="fine" style="margin-top: 1rem">
            Free with your own Gemini API key. Your first 5 reviews are on us.
          </p>
        </div>
        ${sampleReview}
      </div>
      <section class="band">
        <h2>How Fletcher works</h2>
        <div class="features">
          <div>
            <h3>Every pull request, every push</h3>
            <p>
              Install Fletcher on the repositories you choose. He reviews each
              new pull request and each push to it within a minute.
            </p>
          </div>
          <div>
            <h3>Comments on the line</h3>
            <p>
              Each comment sits on the changed line it's about and says what to
              do instead. Critical problems are marked loudest.
            </p>
          </div>
          <div>
            <h3>Ask again</h3>
            <p>
              Comment <code>/fletcher again</code> on a pull request for a fresh
              review. Add <code>.fletcher.json</code> to tune what he looks at.
            </p>
          </div>
        </div>
      </section>
      <section class="band">
        <h2>Your code</h2>
        <p>
          To review a pull request, Fletcher sends its changes to Google's
          Gemini API. He only reads repositories you install him on, and you can
          remove him from GitHub at any time.
        </p>
      </section>`,
  );

export const notFoundPage = (login: string | null) =>
  messagePage(
    "This page doesn't exist",
    login,
    html`<p>The link may be old, or the page belongs to another account.</p>
      <a class="btn" href="/dashboard">Go to your repositories</a>`,
  );

export const signInErrorPage = (explanation: string) =>
  messagePage(
    "GitHub sign-in didn't finish",
    null,
    html`<p>${explanation}</p>
      <a class="btn" href="/auth/login">Sign in with GitHub</a>`,
  );

const pullRequestUrl = (fullName: string, pullRequestNumber: number) =>
  `https://github.com/${fullName}/pull/${pullRequestNumber}`;

const repositoryRow = (
  { repository, latest }: RepositoryOverview,
  now: Date,
) => {
  const outcome =
    latest === null ? null : reviewOutcome(latest.run, latest.counts);

  return html`<li class="entry">
    <span class="entry-mark">${outcome === null ? "" : outcome.mark}</span>
    <div>
      <p class="entry-title">
        <a href="/dashboard/repositories/${repository.id}"
          >${repository.fullName}</a
        >
        <span class="quiet"
          >${repository.enabled ? "Reviews on" : "Reviews off"}</span
        >
      </p>
      <p class="entry-detail">
        ${
          latest === null || outcome === null
            ? html`<span class="quiet">No reviews yet</span>`
            : html`<a href="/dashboard/runs/${latest.run.id}"
                  >Pull request ${latest.run.pullRequestNumber}</a
                >,
                <span class="quiet"
                  >${relativeTime(latest.run.createdAt, now)}</span
                >: ${outcome.text}`
        }
      </p>
    </div>
  </li>`;
};

export const dashboardPage = (
  login: string,
  overview: {
    readonly repositories: readonly RepositoryOverview[];
    readonly totals: {
      readonly reviewCount: number;
      readonly totalTokens: number;
    };
  },
  now: Date,
) =>
  layout(
    "Your repositories",
    login,
    html`<div class="page-head">
        <h1 class="page-title">Your repositories</h1>
        <a href="/onboarding">Choose which repositories Fletcher reviews</a>
      </div>
      ${
        overview.repositories.length === 0
          ? html`<p>
                Install Fletcher on a repository to get your first review.
              </p>
              <a class="btn" href="/onboarding">Set up Fletcher</a>`
          : html`<ul class="entries">
                ${overview.repositories.map((entry) => repositoryRow(entry, now))}
              </ul>
              <p class="fine">
                ${formatNumber(overview.totals.reviewCount)}
                ${overview.totals.reviewCount === 1 ? "review" : "reviews"} so
                far, using ${formatNumber(overview.totals.totalTokens)} Gemini
                tokens.
              </p>`
      }`,
  );

const reviewRow = (
  repository: GitHubRepository,
  { run, counts }: ReviewSummary,
  now: Date,
) => {
  const outcome = reviewOutcome(run, counts);

  return html`<li class="entry">
    <span class="entry-mark">${outcome.mark}</span>
    <div>
      <p class="entry-title">
        <a href="/dashboard/runs/${run.id}"
          >Pull request ${run.pullRequestNumber}</a
        >
        ${outcome.text}
      </p>
      <p class="entry-detail quiet">
        ${triggerLabel(run.trigger)}, ${relativeTime(run.createdAt, now)}.
        <a href="${pullRequestUrl(repository.fullName, run.pullRequestNumber)}"
          >View on GitHub</a
        >
      </p>
    </div>
  </li>`;
};

export const repositoryRunsPage = (
  login: string,
  repository: GitHubRepository,
  reviews: readonly ReviewSummary[],
  now: Date,
) =>
  layout(
    repository.fullName,
    login,
    html`<p class="crumbs"><a href="/dashboard">Your repositories</a></p>
      <div class="page-head">
        <h1 class="page-title">${repository.fullName}</h1>
        ${reviewSwitch(repository, "repository")}
      </div>
      ${
        reviews.length === 0
          ? html`<p>
              No reviews yet. Open a pull request and Fletcher reviews it within
              a minute.
            </p>`
          : html`<ul class="entries">
              ${reviews.map((review) => reviewRow(repository, review, now))}
            </ul>`
      }`,
  );

// Only praise a run that was actually reviewed; a completed run without a
// model was skipped by `.fletcher.json`.
const emptyFindingsMessage = (run: ReviewRun) => {
  switch (run.status) {
    case "queued":
    case "running":
      return "Review in progress. No findings yet.";
    case "failed":
      return "The review failed before producing findings.";
    case "cancelled":
      return "The review was cancelled.";
    case "completed":
      return run.model === null
        ? "Review skipped: disabled by .fletcher.json."
        : "No findings. ...Good job.";
  }
};

export const runFindingsPage = (
  login: string,
  run: ReviewRun,
  findings: readonly Finding[],
) =>
  layout(
    `Review of pull request ${run.pullRequestNumber}`,
    login,
    html`<p class="crumbs">
        <a href="/dashboard/repositories/${run.repositoryId}">All reviews</a>
      </p>
      <h1 class="page-title">
        Review of pull request #${run.pullRequestNumber}
      </h1>
      <p class="quiet">
        Commit <span class="code">${run.headSha.slice(0, 7)}</span>, status
        <span class="status-${run.status}">${run.status}</span
        >${run.errorCode === null ? "" : html`, error ${run.errorCode}`}${run.model === null ? "" : html`, reviewed with ${run.model}`}.
      </p>
      ${
        findings.length === 0
          ? html`<p>${emptyFindingsMessage(run)}</p>`
          : html`<div class="table-wrap">
              <table class="data">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Location</th>
                    <th>Finding</th>
                    <th class="num">Confidence</th>
                    <th class="num">Comment</th>
                  </tr>
                </thead>
                <tbody>
                  ${findings.map(
                    (finding) =>
                      html`<tr>
                        <td class="severity-${finding.severity}">
                          ${finding.severity}
                        </td>
                        <td class="code">
                          ${finding.filePath}${finding.line === null ? "" : `:${finding.line}`}
                        </td>
                        <td class="finding">
                          ${finding.title === null ? "" : html`<strong>${finding.title}</strong><br />`}
                          ${finding.message}
                        </td>
                        <td class="num">
                          ${finding.confidence === null ? "" : finding.confidence.toFixed(2)}
                        </td>
                        <td class="num">${finding.githubCommentId ?? ""}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }`,
  );

export const onboardingPage = (
  login: string,
  installUrl: string,
  repositories: readonly GitHubRepository[],
) => {
  const installed = repositories.length > 0;
  const reviewing = repositories.some((repository) => repository.enabled);

  return layout(
    "Set up Fletcher",
    login,
    html`<h1 class="page-title">Set up Fletcher</h1>
      <ol class="steps">
        ${rehearsalStep(
          "A",
          installed,
          html`<h3>Install Fletcher on GitHub</h3>
            <p>
              Pick a personal account or organization, then the repositories
              Fletcher may review. GitHub sends you back here when you're done.
            </p>
            <a class="btn" href="${installUrl}">
              ${installed ? "Add or remove repositories on GitHub" : "Install on GitHub"}
            </a>`,
        )}
        ${rehearsalStep(
          "B",
          reviewing,
          html`<h3>Choose which repositories get reviews</h3>
            ${
              installed
                ? html`<table class="repos">
                    <tbody>
                      ${repositories.map(
                        (repository) =>
                          html`<tr>
                            <td>${repository.fullName}</td>
                            <td>${reviewSwitch(repository, "onboarding")}</td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>`
                : html`<p class="quiet">
                    Repositories you allow on GitHub appear here.
                  </p>`
            }`,
        )}
        ${rehearsalStep(
          "C",
          false,
          html`<h3>Open a pull request</h3>
            <p>
              Fletcher reviews it within a minute, and reviews again on every
              push. Comment <code>/fletcher again</code> on a pull request to
              ask for another review.
            </p>`,
        )}
      </ol>`,
  );
};

export const installationPendingPage = () =>
  messagePage(
    "Waiting for approval",
    null,
    html`<p>
        Your request to install Fletcher went to the organization's owners.
        GitHub lets you know when one of them approves it.
      </p>
      <a class="btn" href="/auth/login?next=onboarding">
        Sign in again after approval
      </a>`,
  );

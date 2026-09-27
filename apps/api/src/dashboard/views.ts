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
  failureReason,
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

const verdictHeadlines = {
  not_my_tempo: "Not quite my tempo.",
  almost: "Almost.",
  good_job: "…Good job.",
} as const;

// Runs reviewed before verdicts were stored fall back to their loudest
// finding, matching the rubric Fletcher uses for verdicts.
const inferredVerdict = (findings: readonly Finding[]) =>
  findings.some((finding) => finding.severity === "critical")
    ? "not_my_tempo"
    : findings.length > 0
      ? "almost"
      : "good_job";

/** Headline and one explanatory line for a run's current state. */
const reviewHeadline = (run: ReviewRun, findings: readonly Finding[]) => {
  switch (run.status) {
    case "queued":
    case "running":
      return {
        headline: "Reviewing now",
        tone: "active",
        note: "Fletcher is reading this pull request. Reload in a minute for his review.",
      };
    case "failed":
      return {
        headline: "Review failed",
        tone: "failed",
        note: html`The review failed because ${failureReason(run.errorCode)}.
          Comment <code>/fletcher again</code> on the pull request to retry.`,
      };
    case "cancelled":
      return { headline: "Review cancelled", tone: "quiet", note: null };
    case "completed": {
      if (run.model === null) {
        return {
          headline: "Review skipped",
          tone: "quiet",
          note: "This repository's .fletcher.json turns reviews off.",
        };
      }

      const verdict = run.verdict ?? inferredVerdict(findings);

      return {
        headline: verdictHeadlines[verdict],
        tone: verdict === "not_my_tempo" ? "failed" : "verdict",
        note: null,
      };
    }
  }
};

const findingLocation = (finding: Finding) =>
  finding.line === null
    ? finding.filePath
    : `${finding.filePath}:${finding.line}`;

const findingItem = (
  repository: GitHubRepository,
  run: ReviewRun,
  finding: Finding,
) =>
  html`<li class="annotation finding">
    ${dynamicMark(finding.severity)}
    <div>
      <p class="finding-where">
        <span class="code">${findingLocation(finding)}</span>
        ${
          finding.githubCommentId === null
            ? ""
            : html`<a
                href="${pullRequestUrl(repository.fullName, run.pullRequestNumber)}#discussion_r${finding.githubCommentId}"
                >View comment on GitHub</a
              >`
        }
      </p>
      ${finding.title === null ? "" : html`<h3>${finding.title}</h3>`}
      <p>${finding.message}</p>
    </div>
  </li>`;

export const runFindingsPage = (
  login: string,
  repository: GitHubRepository,
  run: ReviewRun,
  findings: readonly Finding[],
  now: Date,
) => {
  const { headline, tone, note } = reviewHeadline(run, findings);

  return layout(
    `Pull request ${run.pullRequestNumber}: ${headline}`,
    login,
    html`<p class="crumbs">
        <a href="/dashboard/repositories/${repository.id}"
          >${repository.fullName}</a
        >
      </p>
      <h1 class="verdict verdict-${tone}">${headline}</h1>
      <p class="quiet">
        Pull request ${run.pullRequestNumber} in ${repository.fullName},
        ${triggerLabel(run.trigger).toLowerCase()}
        ${relativeTime(run.createdAt, now)}.
        <a href="${pullRequestUrl(repository.fullName, run.pullRequestNumber)}"
          >View on GitHub</a
        >
      </p>
      ${note === null ? "" : html`<p>${note}</p>`}
      ${run.summary === null ? "" : html`<p class="lede summary">${run.summary}</p>`}
      ${
        findings.length === 0
          ? run.status === "completed" && run.model !== null
            ? html`<p>No findings on this pull request.</p>`
            : ""
          : html`<h2 class="findings-heading">
                ${`${findings.length} ${findings.length === 1 ? "finding" : "findings"}`}
              </h2>
              <ol class="findings">
                ${findings.map((finding) => findingItem(repository, run, finding))}
              </ol>`
      }
      <dl class="details">
        <div>
          <dt>Commit</dt>
          <dd class="code">${run.headSha.slice(0, 7)}</dd>
        </div>
        ${
          run.model === null
            ? ""
            : html`<div>
                <dt>Model</dt>
                <dd>${run.model}</dd>
              </div>`
        }
        ${
          run.totalTokens === null
            ? ""
            : html`<div>
                <dt>Tokens</dt>
                <dd>${formatNumber(run.totalTokens)}</dd>
              </div>`
        }
      </dl>`,
  );
};

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

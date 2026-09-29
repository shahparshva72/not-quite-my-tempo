import { html } from "hono/html";
import type {
  Finding,
  GitHubRepository,
  ReviewRun,
  VisibleRepository,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
} from "@not-quite-my-tempo/db";

import {
  repositoryActionAllowed,
  workspaceActionAllowed,
} from "../application/authorization.js";
import { trialStatus } from "../application/workspace-settings.js";
import type { TrialStatus } from "../application/workspace-settings.js";

import type { HtmlContent } from "./components.js";
import type {
  RepositoryOverview,
  ReviewSummary,
  WorkspaceOverview,
} from "../application/read-api.js";
import {
  avatar,
  crumbs,
  dynamicMark,
  failureReason,
  formatNumber,
  icon,
  layout,
  logo,
  messagePage,
  pageHead,
  rehearsalStep,
  relativeTime,
  reviewControl,
  reviewOutcome,
  reviewsBadge,
  triggerLabel,
  withGitHub,
} from "./components.js";

const sampleReview = html`<figure class="sample">
  <figcaption class="sample-head">
    ${logo}
    <span><strong>Fletcher</strong> reviewed pull request 42</span>
    <span class="badge badge-failed">1 critical</span>
  </figcaption>
  <div class="sample-body">
    <p class="fine"><strong class="code">src/tempo.ts</strong></p>
    <pre><span class="ln">12</span>export const beatLength = (bar: Bar) =&gt; {
<span class="ln">13</span>  const beats = bar.signature.beats;
<span class="ln">14</span>  <span class="flagged">return bar.duration / beats;<svg class="pencil" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><ellipse cx="50" cy="20" rx="48" ry="17" transform="rotate(-2 50 20)" /></svg></span>
<span class="ln">15</span>};</pre>
    <div class="annotation">
      ${dynamicMark("critical")}
      <div>
        <p><strong>Were you rushing or were you dragging?</strong></p>
        <p>
          A 0/4 signature divides by zero here. Reject a bar with no beats
          before you divide.
        </p>
      </div>
    </div>
  </div>
</figure>`;

const feature = (
  mark: ReturnType<typeof icon> | HtmlContent,
  title: string,
  body: HtmlContent,
) =>
  html`<div class="card feature">
    <span class="feature-icon">${mark}</span>
    <h3>${title}</h3>
    <p>${body}</p>
  </div>`;

const check = (text: HtmlContent | string) =>
  html`<li>${icon("check")}<span>${text}</span></li>`;

export const landingPage = () =>
  layout(
    "Code review from Fletcher",
    null,
    html`<div class="hero">
        <div>
          <a class="pill" href="#how"
            ><span class="badge badge-brass">GitHub App</span> Reviews every
            pull request in about a minute</a
          >
          <h1 class="headline">
            <span class="on-staff">Not quite my tempo.</span>
          </h1>
          <p class="lede">
            Fletcher reviews every pull request you open. He marks what's wrong
            on the exact line and tells you how to fix it. He is not gentle, but
            he is right.
          </p>
          <div class="actions">
            <a class="btn btn-lg" href="/auth/login"
              >${withGitHub("Sign in with GitHub")}</a
            >
            <a class="btn btn-secondary btn-lg" href="#how">See how it works</a>
          </div>
          <ul class="checks">
            ${check("Your first 5 reviews are on us")}
            ${check("Free with your own Gemini API key")}
          </ul>
        </div>
        ${sampleReview}
      </div>
      <section class="band" id="how">
        <div class="band-head">
          <span class="eyebrow">How Fletcher works</span>
          <h2>A band director for your pull requests</h2>
          <p>
            Install once, pick your repositories, and every pull request gets a
            line-by-line review before anyone else reads it.
          </p>
        </div>
        <div class="features">
          ${feature(
            icon("pullRequest"),
            "Every pull request, every push",
            html`Install Fletcher on the repositories you choose. He reviews
            each new pull request and each push to it within a minute.`,
          )}
          ${feature(
            icon("message"),
            "Comments on the line",
            html`Each comment sits on the changed line it's about and says what
            to do instead. Critical problems are marked loudest.`,
          )}
          ${feature(
            icon("refresh"),
            "Ask again",
            html`Comment <code>/fletcher again</code> on a pull request for a
              fresh review. Add <code>.fletcher.json</code> to tune what he
              looks at.`,
          )}
        </div>
      </section>
      <section class="band">
        <div class="band-head">
          <span class="eyebrow">Get started</span>
          <h2>Three steps to your first review</h2>
        </div>
        <ol class="steps landing-steps">
          ${rehearsalStep(
            "A",
            false,
            html`<h3>Sign in with GitHub</h3>
              <p>No new password. Fletcher uses your GitHub account.</p>`,
          )}
          ${rehearsalStep(
            "B",
            false,
            html`<h3>Install on your repositories</h3>
              <p>
                Choose a personal account or organization, then repositories.
              </p>`,
          )}
          ${rehearsalStep(
            "C",
            false,
            html`<h3>Open a pull request</h3>
              <p>Fletcher's review lands on GitHub within a minute.</p>`,
          )}
        </ol>
      </section>
      <section class="band" id="pricing">
        <div class="band-head">
          <span class="eyebrow">Pricing</span>
          <h2>Start free. Stay free with your own key.</h2>
          <p>
            Every workspace gets 5 reviews on Fletcher's key. After that, add a
            Gemini API key and Google bills its usage to you.
          </p>
        </div>
        <div class="plans">
          <div class="card plan plan-featured">
            <div class="plan-top">
              <h3>Bring your own key</h3>
              <span class="badge badge-brass">Available now</span>
            </div>
            <p class="price">$0 <small>per workspace</small></p>
            <p>Unlimited reviews on your own Gemini or Vertex AI key.</p>
            <ul class="checks">
              ${check("5 free reviews on Fletcher's key to start")}
              ${check("Every pull request and every push")}
              ${check("Owners, admins, and members from GitHub")}
              ${check("Key stored encrypted, shown only by its last 4")}
            </ul>
            <a class="btn" href="/auth/login"
              >${withGitHub("Sign in with GitHub")}</a
            >
          </div>
          <div class="card plan">
            <div class="plan-top">
              <h3>Hosted</h3>
              <span class="badge">Coming soon</span>
            </div>
            <p class="price">Paid <small>per workspace</small></p>
            <p>
              Reviews on Fletcher's key, so there's no Google account to set up.
            </p>
            <ul class="checks">
              ${check("Everything in Bring your own key")}
              ${check("No Gemini key to manage")}
              ${check("One bill for the whole workspace")}
            </ul>
            <a class="btn btn-secondary" href="/auth/login"
              >Start with the trial</a
            >
          </div>
        </div>
      </section>
      <section class="band" id="privacy">
        <div class="band-head">
          <span class="eyebrow">Privacy</span>
          <h2>Fletcher only reads what you hand him</h2>
        </div>
        <div class="features">
          ${feature(
            icon("lock"),
            "Your code",
            html`To review a pull request, Fletcher sends its changes to
            Google's Gemini API. He only reads repositories you install him on.`,
          )}
          ${feature(
            icon("key"),
            "Your key",
            html`Keys are checked with Google before saving, stored encrypted,
            and never shown again in full.`,
          )}
          ${feature(
            icon("users"),
            "Your team",
            html`Roles follow GitHub. Owners choose admins, and you can remove
            Fletcher from GitHub at any time.`,
          )}
        </div>
      </section>
      <section class="card cta">
        <div>
          <h2>Ready for rehearsal?</h2>
          <p>Sign in, install on a repository, and open a pull request.</p>
        </div>
        <a class="btn btn-lg" href="/auth/login"
          >${withGitHub("Sign in with GitHub")}</a
        >
      </section>`,
  );

export const notFoundPage = (login: string | null) =>
  messagePage(
    "This page doesn't exist",
    login,
    html`<p>The link may be old, or the page belongs to another account.</p>
      <a class="btn" href="/dashboard">Go to your repositories</a>`,
  );

export const forbiddenPage = (login: string, requiredRole: string) =>
  messagePage(
    requiredRole === "owner"
      ? "Only owners can do this"
      : "You need admin access",
    login,
    html`<p>
        ${
          requiredRole === "owner"
            ? "Only owners of this GitHub account can make this change."
            : "Only admins and owners can turn Fletcher's reviews on or off. Ask an owner of this GitHub account to make you an admin."
        }
      </p>
      <a class="btn" href="/dashboard">Go to your repositories</a>`,
  );

export const signInErrorPage = (explanation: string) =>
  messagePage(
    "GitHub sign-in didn't finish",
    null,
    html`<p>${explanation}</p>
      <a class="btn" href="/auth/login"
        >${withGitHub("Sign in with GitHub")}</a
      >`,
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
    <span class="entry-mark"
      >${
        outcome === null
          ? html`<span class="dot" aria-hidden="true"></span>`
          : outcome.mark
      }</span
    >
    <div>
      <p class="entry-title">
        <a href="/dashboard/repositories/${repository.id}"
          >${repository.fullName}</a
        >
        ${reviewsBadge(repository.enabled)}
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
    <a
      class="entry-go"
      href="/dashboard/repositories/${repository.id}"
      aria-hidden="true"
      tabindex="-1"
      >${icon("chevronRight")}</a
    >
  </li>`;
};

const roleLabels = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const satisfies Record<WorkspaceRole, string>;

const trialMeter = (remaining: number, total: number) =>
  html`<span
    class="meter${remaining === 0 ? " meter-empty" : ""}"
    role="img"
    aria-label="${remaining} of ${total} free reviews left"
    ><span
      style="width: ${Math.round(((remaining === 0 ? total : remaining) / total) * 100)}%"
    ></span
  ></span>`;

/** One line on the dashboard: whose Gemini key reviews use. */
const keyStatusLine = (workspace: Workspace, trialReviewsUsed: number) => {
  const trial = trialStatus(trialReviewsUsed);

  return workspace.geminiKeyLast4 !== null
    ? html`${icon("key")}
        <span class="quiet">Reviews use this workspace's Gemini key.</span>`
    : trial.remaining > 0
      ? html`${trialMeter(trial.remaining, trial.total)}
          <span class="quiet"
            >${trial.remaining} of ${trial.total} free reviews left.</span
          >
          <a href="/workspaces/${workspace.id}/settings"
            >Add your Gemini key</a
          >`
      : html`${trialMeter(0, trial.total)}
          <span class="state-failed"
            >Free reviews used up. Reviews are paused.</span
          >
          <a href="/workspaces/${workspace.id}/settings"
            >Add your Gemini key</a
          >`;
};

const workspaceSection = (
  { workspace, role, repositories, trialReviewsUsed }: WorkspaceOverview,
  now: Date,
) =>
  html`<section class="card workspace">
    <div class="card-head workspace-head">
      <div class="workspace-title">
        ${avatar(workspace.githubAccountLogin, true)}
        <div>
          <h2>${workspace.githubAccountLogin}</h2>
          <span class="fine">${roleLabels[role]}</span>
        </div>
      </div>
      <div class="actions">
        <a
          class="btn btn-secondary btn-sm"
          href="/workspaces/${workspace.id}/members"
          >${icon("users")} Members</a
        >
        <a
          class="btn btn-secondary btn-sm"
          href="/workspaces/${workspace.id}/settings"
          >${icon("settings")} Settings</a
        >
      </div>
    </div>
    ${
      repositories.length === 0
        ? html`<div class="card-body">
            <p class="quiet">
              None of this account's repositories are visible to you on GitHub.
            </p>
          </div>`
        : html`<ul class="entries">
            ${repositories.map((entry) => repositoryRow(entry, now))}
          </ul>`
    }
    <div class="card-foot">
      <p class="key-status">${keyStatusLine(workspace, trialReviewsUsed)}</p>
    </div>
  </section>`;

const stat = (label: string, value: string) =>
  html`<div class="card stat">
    <p class="stat-label">${label}</p>
    <p class="stat-value">${value}</p>
  </div>`;

export const dashboardPage = (
  login: string,
  overview: {
    readonly workspaces: readonly WorkspaceOverview[];
    readonly totals: {
      readonly reviewCount: number;
      readonly totalTokens: number;
    };
  },
  now: Date,
) => {
  const repositories = overview.workspaces.flatMap(
    (workspace) => workspace.repositories,
  );

  const reviewing = repositories.filter(
    ({ repository }) => repository.enabled,
  ).length;

  return layout(
    "Your repositories",
    login,
    html`${pageHead(
      "Your repositories",
      "Fletcher's latest review on each repository you can see.",
      html`<a class="btn btn-secondary" href="/onboarding"
        >${icon("settings")} Manage repositories</a
      >`,
    )}
    ${
      overview.workspaces.length === 0
        ? html`<div class="card empty">
            <span class="feature-icon">${icon("repo")}</span>
            <h2>No repositories yet</h2>
            <p>Install Fletcher on a repository to get your first review.</p>
            <a class="btn" href="/onboarding">Set up Fletcher</a>
          </div>`
        : html`<div class="stats">
              ${stat("Reviews", formatNumber(overview.totals.reviewCount))}
              ${stat(
                "Repositories reviewed",
                `${formatNumber(reviewing)} of ${formatNumber(repositories.length)}`,
              )}
              ${stat("Workspaces", formatNumber(overview.workspaces.length))}
              ${stat(
                "Gemini tokens",
                formatNumber(overview.totals.totalTokens),
              )}
            </div>
            ${overview.workspaces.map((workspace) =>
              workspaceSection(workspace, now),
            )}
            <p class="fine">
              ${formatNumber(overview.totals.reviewCount)}
              ${overview.totals.reviewCount === 1 ? "review" : "reviews"} so
              far, using ${formatNumber(overview.totals.totalTokens)} Gemini
              tokens.
            </p>`
    }`,
    "repositories",
  );
};

const memberRoleLabels = {
  owner: "Owner on GitHub",
  admin: "Admin",
  member: "Member",
} as const satisfies Record<WorkspaceRole, string>;

const memberControl = (
  workspaceId: number,
  member: WorkspaceMember,
  viewerRole: WorkspaceRole,
) =>
  viewerRole !== "owner" || member.role === "owner"
    ? ""
    : html`<form
        method="post"
        action="/workspaces/${workspaceId}/members/${member.userId}/role"
      >
        <input
          type="hidden"
          name="role"
          value="${member.role === "admin" ? "member" : "admin"}"
        />
        <button class="btn btn-secondary btn-sm" type="submit">
          ${member.role === "admin" ? "Remove admin" : "Make admin"}
        </button>
      </form>`;

export const membersPage = (
  login: string,
  data: {
    readonly workspace: Workspace;
    readonly viewerRole: WorkspaceRole;
    readonly viewerUserId: number;
    readonly members: readonly WorkspaceMember[];
  },
) => {
  const { workspace, viewerRole, viewerUserId, members } = data;
  const organization = workspace.accountType === "Organization";
  const hasOwner = members.some((member) => member.role === "owner");

  return layout(
    `Members of ${workspace.githubAccountLogin}`,
    login,
    html`${crumbs(
        [["/dashboard", "Your repositories"]],
        workspace.githubAccountLogin,
      )}
      ${pageHead(
        `Members of ${workspace.githubAccountLogin}`,
        html`Owners come from GitHub:
        ${organization ? "the organization's owners" : "the account holder"}.
        Owners choose admins, who can turn Fletcher's reviews on or off.
        Everyone else sees reviews for the repositories they can see on GitHub.`,
      )}
      ${
        hasOwner
          ? ""
          : html`<p class="notice" role="status">
              ${icon("info")}
              <span
                >No owner has signed in yet. An owner of this GitHub
                ${organization ? "organization" : "account"} needs to sign in to
                choose admins.</span
              >
            </p>`
      }
      <section class="card">
        <div class="card-head">
          <h2>
            ${members.length} ${members.length === 1 ? "person" : "people"}
          </h2>
        </div>
        <div class="card-body">
          <table class="repos members">
            <tbody>
              ${members.map(
                (member) =>
                  html`<tr>
                    <td>
                      ${avatar(member.login)}
                      <span
                        >${member.login}${
                          member.userId === viewerUserId ? " (you)" : ""
                        }</span
                      >
                    </td>
                    <td>
                      <span
                        class="badge${member.role === "member" ? "" : " badge-on"}"
                        >${memberRoleLabels[member.role]}</span
                      >
                    </td>
                    <td>${memberControl(workspace.id, member, viewerRole)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>
        <div class="card-foot">
          <p class="fine">
            People appear here after they sign in, if GitHub shows them this
            account's installation.
          </p>
        </div>
      </section>`,
  );
};

export type SettingsNotice =
  | "saved"
  | "removed"
  | "invalid_format"
  | "rejected"
  | "unavailable";

const noticeMessages = {
  saved: "Key saved. Reviews now use it.",
  removed: "Key removed.",
  invalid_format:
    "That doesn't look like a Gemini API key. Paste only the key, with no spaces or quotes.",
  rejected:
    "Google rejected that key for both the Gemini API and Vertex AI. Check that it's active and allowed to use one of them.",
  unavailable:
    "Google didn't answer, so the key wasn't saved. Try again in a minute.",
} as const satisfies Record<SettingsNotice, string>;

const settingsNotice = (notice: SettingsNotice | null) =>
  notice === null
    ? ""
    : notice === "saved" || notice === "removed"
      ? html`<p class="notice" role="status">
          ${icon("check")}<span>${noticeMessages[notice]}</span>
        </p>`
      : html`<p class="notice notice-error" role="alert">
          ${icon("info")}<span>${noticeMessages[notice]}</span>
        </p>`;

const keySummary = (workspace: Workspace, trial: TrialStatus, now: Date) => {
  if (workspace.geminiKeyLast4 !== null) {
    return html`<div class="key-chip">
      <span class="feature-icon">${icon("key")}</span>
      <p>
        Reviews use this workspace's
        ${workspace.geminiKeyProvider === "vertex_express" ? "Vertex AI" : "Gemini API"}
        key, ending in <span class="code">…${workspace.geminiKeyLast4}</span>.
        ${
          workspace.geminiKeyUpdatedAt === null
            ? ""
            : html`Added ${relativeTime(workspace.geminiKeyUpdatedAt, now)}.`
        }
      </p>
    </div>`;
  }

  return trial.remaining > 0
    ? html`<div class="key-chip">
        ${trialMeter(trial.remaining, trial.total)}
        <p>
          No key yet. ${trial.remaining} of ${trial.total} free reviews are left
          on Fletcher's key. After that, reviews need this workspace's own key.
        </p>
      </div>`
    : html`<div class="key-chip">
        ${trialMeter(0, trial.total)}
        <p class="state-failed">
          No key, and the ${trial.total} free reviews are used. Fletcher won't
          review pull requests until an admin or owner adds a key.
        </p>
      </div>`;
};

export const settingsPage = (
  login: string,
  data: {
    readonly workspace: Workspace;
    readonly viewerRole: WorkspaceRole;
    readonly trial: TrialStatus;
  },
  notice: SettingsNotice | null,
  now: Date,
) => {
  const { workspace, viewerRole, trial } = data;
  const canManage = workspaceActionAllowed(viewerRole, "manage_settings");
  const hasKey = workspace.geminiKeyLast4 !== null;

  return layout(
    `Settings for ${workspace.githubAccountLogin}`,
    login,
    html`${crumbs(
        [["/dashboard", "Your repositories"]],
        workspace.githubAccountLogin,
      )}
      ${pageHead(
        `Settings for ${workspace.githubAccountLogin}`,
        "Choose which Gemini key Fletcher's reviews use.",
      )}
      ${settingsNotice(notice)}
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Gemini API key</h2></div>
          <div class="card-body">
            ${keySummary(workspace, trial, now)}
            ${
              canManage
                ? html`<form
                    class="key-form"
                    method="post"
                    action="/workspaces/${workspace.id}/settings/gemini-key"
                  >
                    <label for="api-key"
                      >${hasKey ? "New Gemini API key" : "Gemini API key"}</label
                    >
                    <input
                      id="api-key"
                      name="api_key"
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      required
                      aria-describedby="api-key-help"
                    />
                    <p id="api-key-help" class="fine">
                      Paste a Gemini API key from Google AI Studio or a Vertex
                      AI API key. Fletcher checks it with Google before saving,
                      stores it encrypted, and only ever shows its last 4
                      characters. Google bills reviews that use it to your
                      account.
                    </p>
                    <button class="btn" type="submit">
                      ${hasKey ? "Replace key" : "Save key"}
                    </button>
                  </form>`
                : html`<p class="quiet" style="margin: 1rem 0 0">
                    Only admins and owners can change the key.
                  </p>`
            }
          </div>
        </section>
        ${
          canManage && hasKey
            ? html`<section class="card">
                <div class="card-body danger-zone">
                  <div>
                    <h3>Remove key</h3>
                    <p class="fine">
                      Deletes this workspace's saved key. Admins and owners can
                      add a key again at any time.
                    </p>
                  </div>
                  <form
                    method="post"
                    action="/workspaces/${workspace.id}/settings/gemini-key/remove"
                  >
                    <button class="btn btn-danger btn-sm" type="submit">
                      Remove key
                    </button>
                  </form>
                </div>
              </section>`
            : ""
        }
      </div>`,
  );
};

export const ownerRolePage = (login: string) =>
  messagePage(
    "Owners come from GitHub",
    login,
    html`<p>
        An owner's role follows GitHub. To change it, change who owns the
        account or organization on GitHub.
      </p>
      <a class="btn" href="/dashboard">Go to your repositories</a>`,
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
    <a
      class="entry-go"
      href="/dashboard/runs/${run.id}"
      aria-hidden="true"
      tabindex="-1"
      >${icon("chevronRight")}</a
    >
  </li>`;
};

export const repositoryRunsPage = (
  login: string,
  repository: GitHubRepository,
  role: WorkspaceRole,
  reviews: readonly ReviewSummary[],
  now: Date,
) =>
  layout(
    repository.fullName,
    login,
    html`${crumbs([["/dashboard", "Your repositories"]], repository.fullName)}
    ${pageHead(
      repository.fullName,
      html`<a href="https://github.com/${repository.fullName}"
        >View repository on GitHub</a
      >`,
      reviewControl(
        repository,
        repositoryActionAllowed(role, "toggle_reviews"),
        "repository",
      ),
    )}
    ${
      reviews.length === 0
        ? html`<div class="card empty">
            <span class="feature-icon">${icon("pullRequest")}</span>
            <h2>No reviews yet</h2>
            <p>Open a pull request and Fletcher reviews it within a minute.</p>
          </div>`
        : html`<section class="card">
            <div class="card-head">
              <h2>Reviews</h2>
              <span class="badge">${formatNumber(reviews.length)}</span>
            </div>
            <ul class="entries">
              ${reviews.map((review) => reviewRow(repository, review, now))}
            </ul>
          </section>`
    }`,
    "repositories",
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
  html`<li class="annotation finding finding-${finding.severity}">
    ${dynamicMark(finding.severity)}
    <div>
      <p class="finding-where">
        <span class="code">${findingLocation(finding)}</span>
        ${
          finding.githubCommentId === null
            ? ""
            : html`<a
                href="${pullRequestUrl(repository.fullName, run.pullRequestNumber)}#discussion_r${finding.githubCommentId}"
                >View comment on GitHub ${icon("external")}</a
              >`
        }
      </p>
      ${finding.title === null ? "" : html`<h3>${finding.title}</h3>`}
      <p>${finding.message}</p>
    </div>
  </li>`;

const tallyLabels = {
  critical: "Critical",
  warning: "Warnings",
  suggestion: "Suggestions",
} as const satisfies Record<Finding["severity"], string>;

/** Side panel counting a review's findings at each severity. */
const findingTally = (findings: readonly Finding[]) =>
  html`<section class="card card-body">
    <h2>Findings</h2>
    <ul class="tally">
      ${(["critical", "warning", "suggestion"] as const).map(
        (severity) =>
          html`<li>
            ${dynamicMark(severity)}
            <span class="quiet">${tallyLabels[severity]}</span>
            <strong
              >${findings.filter((finding) => finding.severity === severity).length}</strong
            >
          </li>`,
      )}
    </ul>
  </section>`;

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
    html`${crumbs(
        [
          ["/dashboard", "Your repositories"],
          [`/dashboard/repositories/${repository.id}`, repository.fullName],
        ],
        `Pull request ${run.pullRequestNumber}`,
      )}
      <div class="review-layout">
        <div>
          <section class="card review-hero">
            <h1 class="verdict verdict-${tone}">${headline}</h1>
            <p class="review-meta">
              Pull request ${run.pullRequestNumber} in ${repository.fullName},
              ${triggerLabel(run.trigger).toLowerCase()}
              ${relativeTime(run.createdAt, now)}.
            </p>
            ${note === null ? "" : html`<p class="review-note">${note}</p>`}
            ${run.summary === null ? "" : html`<p class="summary">${run.summary}</p>`}
          </section>
          ${
            findings.length === 0
              ? run.status === "completed" && run.model !== null
                ? html`<div class="card empty" style="margin-top: 1.5rem">
                    <span class="feature-icon">${icon("check")}</span>
                    <p>No findings on this pull request.</p>
                  </div>`
                : ""
              : html`<h2 class="findings-heading">
                    ${`${findings.length} ${findings.length === 1 ? "finding" : "findings"}`}
                  </h2>
                  <ol class="findings">
                    ${findings.map((finding) => findingItem(repository, run, finding))}
                  </ol>`
          }
        </div>
        <aside class="aside">
          <a
            class="btn btn-secondary"
            href="${pullRequestUrl(repository.fullName, run.pullRequestNumber)}"
            >${withGitHub("View on GitHub")}</a
          >
          ${findings.length === 0 ? "" : findingTally(findings)}
          <section class="card card-body">
            <h2>Details</h2>
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
            </dl>
          </section>
        </aside>
      </div>`,
    "repositories",
  );
};

export const onboardingPage = (
  login: string,
  installUrl: string,
  visible: readonly VisibleRepository[],
) => {
  const repositories = visible.map((entry) => entry.repository);
  const installed = repositories.length > 0;
  const reviewing = repositories.some((repository) => repository.enabled);

  return layout(
    "Set up Fletcher",
    login,
    html`${pageHead(
        "Set up Fletcher",
        "Three steps from install to your first review.",
      )}
      <div class="progress">
        <span
          >${[installed, reviewing].filter(Boolean).length} of 3 steps
          done</span
        >
        <span class="meter" aria-hidden="true"
          ><span
            style="width: ${Math.round(([installed, reviewing].filter(Boolean).length / 3) * 100)}%"
          ></span
        ></span>
      </div>
      <ol class="steps">
        ${rehearsalStep(
          "A",
          installed,
          html`<h3>Install Fletcher on GitHub</h3>
            <p>
              Pick a personal account or organization, then the repositories
              Fletcher may review. GitHub sends you back here when you're done.
            </p>
            <a
              class="btn${installed ? " btn-secondary" : ""}"
              href="${installUrl}"
            >
              ${withGitHub(
                installed
                  ? "Add or remove repositories on GitHub"
                  : "Install on GitHub",
              )}
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
                      ${visible.map(
                        ({ repository, role }) =>
                          html`<tr>
                            <td>
                              <span class="repo-name"
                                >${icon("repo")}${repository.fullName}</span
                              >
                            </td>
                            <td>
                              ${reviewControl(
                                repository,
                                repositoryActionAllowed(role, "toggle_reviews"),
                                "onboarding",
                              )}
                            </td>
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
            </p>
            ${
              reviewing
                ? html`<a class="btn btn-secondary" href="/dashboard"
                    >Go to your repositories ${icon("arrowRight")}</a
                  >`
                : ""
            }`,
        )}
      </ol>`,
    "setup",
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

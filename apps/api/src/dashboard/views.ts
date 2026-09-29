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

import type {
  RepositoryOverview,
  ReviewSummary,
  WorkspaceOverview,
} from "../application/read-api.js";
import {
  dynamicMark,
  failureReason,
  formatNumber,
  layout,
  messagePage,
  rehearsalStep,
  relativeTime,
  reviewControl,
  reviewOutcome,
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

const roleLabels = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const satisfies Record<WorkspaceRole, string>;

/** One line on the dashboard: whose Gemini key reviews use. */
const keyStatusLine = (workspace: Workspace) => {
  const trial = trialStatus(workspace);

  return workspace.geminiKeyLast4 !== null
    ? html`<span class="quiet">Reviews use this workspace's Gemini key.</span>`
    : trial.remaining > 0
      ? html`<span class="quiet"
            >${trial.remaining} of ${trial.total} free reviews left.</span
          >
          <a href="/workspaces/${workspace.id}/settings"
            >Add your Gemini key</a
          >`
      : html`<span class="state-failed"
            >Free reviews used up. Reviews are paused.</span
          >
          <a href="/workspaces/${workspace.id}/settings"
            >Add your Gemini key</a
          >`;
};

const workspaceSection = (
  { workspace, role, repositories }: WorkspaceOverview,
  now: Date,
) =>
  html`<section class="workspace">
    <div class="workspace-head">
      <h2>${workspace.githubAccountLogin}</h2>
      <span class="quiet">${roleLabels[role]}</span>
      <a href="/workspaces/${workspace.id}/members">Members</a>
      <a href="/workspaces/${workspace.id}/settings">Settings</a>
    </div>
    <p class="key-status">${keyStatusLine(workspace)}</p>
    ${
      repositories.length === 0
        ? html`<p class="quiet">
            None of this account's repositories are visible to you on GitHub.
          </p>`
        : html`<ul class="entries">
            ${repositories.map((entry) => repositoryRow(entry, now))}
          </ul>`
    }
  </section>`;

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
) =>
  layout(
    "Your repositories",
    login,
    html`<div class="page-head">
        <h1 class="page-title">Your repositories</h1>
        <a href="/onboarding">Choose which repositories Fletcher reviews</a>
      </div>
      ${
        overview.workspaces.length === 0
          ? html`<p>
                Install Fletcher on a repository to get your first review.
              </p>
              <a class="btn" href="/onboarding">Set up Fletcher</a>`
          : html`${overview.workspaces.map((workspace) =>
                workspaceSection(workspace, now),
              )}
              <p class="fine">
                ${formatNumber(overview.totals.reviewCount)}
                ${overview.totals.reviewCount === 1 ? "review" : "reviews"} so
                far, using ${formatNumber(overview.totals.totalTokens)} Gemini
                tokens.
              </p>`
      }`,
  );

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
        <button class="link-button" type="submit">
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
    html`<p class="crumbs"><a href="/dashboard">Your repositories</a></p>
      <h1 class="page-title">Members of ${workspace.githubAccountLogin}</h1>
      <p>
        Owners come from GitHub:
        ${organization ? "the organization's owners" : "the account holder"}.
        Owners choose admins, who can turn Fletcher's reviews on or off.
        Everyone else sees reviews for the repositories they can see on GitHub.
      </p>
      ${
        hasOwner
          ? ""
          : html`<p class="quiet">
              No owner has signed in yet. An owner of this GitHub
              ${organization ? "organization" : "account"} needs to sign in to
              choose admins.
            </p>`
      }
      <table class="repos members">
        <tbody>
          ${members.map(
            (member) =>
              html`<tr>
                <td>
                  ${member.login}${member.userId === viewerUserId ? " (you)" : ""}
                </td>
                <td class="quiet">${memberRoleLabels[member.role]}</td>
                <td>${memberControl(workspace.id, member, viewerRole)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
      <p class="fine">
        People appear here after they sign in, if GitHub shows them this
        account's installation.
      </p>`,
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
    "Google rejected that key. Check that it's active and allowed to use the Gemini API.",
  unavailable:
    "Google didn't answer, so the key wasn't saved. Try again in a minute.",
} as const satisfies Record<SettingsNotice, string>;

const settingsNotice = (notice: SettingsNotice | null) =>
  notice === null
    ? ""
    : notice === "saved" || notice === "removed"
      ? html`<p class="notice" role="status">${noticeMessages[notice]}</p>`
      : html`<p class="notice notice-error" role="alert">
          ${noticeMessages[notice]}
        </p>`;

const keySummary = (workspace: Workspace, now: Date) => {
  const trial = trialStatus(workspace);

  if (workspace.geminiKeyLast4 !== null) {
    return html`<p>
      Reviews use this workspace's Gemini key, ending in
      <span class="code">…${workspace.geminiKeyLast4}</span>.
      ${
        workspace.geminiKeyUpdatedAt === null
          ? ""
          : html`Added ${relativeTime(workspace.geminiKeyUpdatedAt, now)}.`
      }
    </p>`;
  }

  return trial.remaining > 0
    ? html`<p>
        No key yet. ${trial.remaining} of ${trial.total} free reviews are left
        on Fletcher's key. After that, reviews need this workspace's own key.
      </p>`
    : html`<p class="state-failed">
        No key, and the ${trial.total} free reviews are used. Fletcher won't
        review pull requests until an admin or owner adds a key.
      </p>`;
};

export const settingsPage = (
  login: string,
  data: {
    readonly workspace: Workspace;
    readonly viewerRole: WorkspaceRole;
  },
  notice: SettingsNotice | null,
  now: Date,
) => {
  const { workspace, viewerRole } = data;
  const canManage = workspaceActionAllowed(viewerRole, "manage_settings");
  const hasKey = workspace.geminiKeyLast4 !== null;

  return layout(
    `Settings for ${workspace.githubAccountLogin}`,
    login,
    html`<p class="crumbs"><a href="/dashboard">Your repositories</a></p>
      <h1 class="page-title">Settings for ${workspace.githubAccountLogin}</h1>
      ${settingsNotice(notice)}
      <h2>Gemini API key</h2>
      ${keySummary(workspace, now)}
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
                  Create a key in Google AI Studio. Fletcher checks it with
                  Google before saving, stores it encrypted, and only ever shows
                  its last 4 characters. Google bills reviews that use it to
                  your account.
                </p>
                <button class="btn" type="submit">
                  ${hasKey ? "Replace key" : "Save key"}
                </button>
              </form>
              ${
                hasKey
                  ? html`<form
                      method="post"
                      action="/workspaces/${workspace.id}/settings/gemini-key/remove"
                    >
                      <button class="link-button danger" type="submit">
                        Remove key
                      </button>
                    </form>`
                  : ""
              }`
          : html`<p class="quiet">
              Only admins and owners can change the key.
            </p>`
      }`,
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
    html`<p class="crumbs"><a href="/dashboard">Your repositories</a></p>
      <div class="page-head">
        <h1 class="page-title">${repository.fullName}</h1>
        ${reviewControl(
          repository,
          repositoryActionAllowed(role, "toggle_reviews"),
          "repository",
        )}
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
  visible: readonly VisibleRepository[],
) => {
  const repositories = visible.map((entry) => entry.repository);
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
                      ${visible.map(
                        ({ repository, role }) =>
                          html`<tr>
                            <td>${repository.fullName}</td>
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

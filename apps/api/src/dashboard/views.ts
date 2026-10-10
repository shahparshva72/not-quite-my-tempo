import { Match, Option } from "effect";
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
import { hasOpenSubscription, hasPaidPlan } from "../application/billing.js";
import { trialStatus } from "../application/workspace-settings.js";
import type { TrialStatus } from "../application/workspace-settings.js";
import type { PlanPrice } from "../billing/polar-client.js";
import {
  DEFAULT_MODELS,
  DEFAULT_PLAN_MODEL,
  ENABLED_VENDORS,
  isPlanModel,
  LARGE_REVIEW_MULTIPLIER,
  MODEL_CATALOG,
  vendorOf,
} from "@not-quite-my-tempo/reviewer";
import type {
  ModelTier,
  ModelVendor,
  ReviewProvider,
} from "@not-quite-my-tempo/reviewer";

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
  isoDate,
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

/** What pages know about the paid plan: whether it's sold, and for what. */
export interface PaidPlanOffer {
  readonly billingEnabled: boolean;
  readonly price: Option.Option<PlanPrice>;
}

const PAID_PLAN_NAME = "Fletcher Pro";

const planName = (offer: PaidPlanOffer) =>
  Option.match(offer.price, {
    onNone: () => PAID_PLAN_NAME,
    onSome: (price) => price.productName,
  });

/** "$10", or "$9.50" when there are cents. */
const formatAmount = (price: PlanPrice) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
  }).format(price.amount / 100);

/** "$10/month", or "$49" for a one-time price. */
const formatPrice = (price: PlanPrice) =>
  price.interval === null
    ? formatAmount(price)
    : `${formatAmount(price)}/${price.interval}`;

const hostedPlanCard = (offer: PaidPlanOffer) => {
  const priceLine = Option.match(offer.price, {
    onNone: () => html`<p class="price">Paid <small>per workspace</small></p>`,
    onSome: (price) =>
      html`<p class="price">
        ${formatAmount(price)}
        <small
          >per
          workspace${
            price.interval === null ? "" : ` / ${price.interval}`
          }</small
        >
      </p>`,
  });

  return html`<div class="card plan">
    <div class="plan-top">
      <h3>${offer.billingEnabled ? planName(offer) : "Hosted"}</h3>
      ${offer.billingEnabled ? "" : html`<span class="badge">Coming soon</span>`}
    </div>
    ${priceLine}
    <p>
      200 review credits a month on Fletcher's keys: up to 200 reviews on
      standard models, or 66 on pro models.
    </p>
    <ul class="checks">
      ${check("Everything in Bring your own key")}
      ${check("Pick Lite, Standard, or Pro Gemini models")}
      ${check("Reviews on your own key never use credits")}
      ${check("One bill for the whole workspace")}
      ${offer.billingEnabled ? check("Cancel any time from the billing portal") : ""}
    </ul>
    <a class="btn btn-secondary" href="/auth/login"
      >${offer.billingEnabled ? "Start with 5 free reviews" : "Start with the trial"}</a
    >
  </div>`;
};

const pricingLede = (offer: PaidPlanOffer) => {
  const trial =
    "Every workspace gets 5 reviews on Fletcher's key. After that, add a " +
    "Gemini key and your provider bills its usage to you";

  if (!offer.billingEnabled) {
    return `${trial}.`;
  }

  const price = Option.match(offer.price, {
    onNone: () => "",
    onSome: (known) => ` for ${formatPrice(known)}`,
  });

  return `${trial}, or subscribe to ${planName(offer)}${price} and skip the key.`;
};

const signInConsent = html`<p class="fine consent">
  By signing in, you agree to the <a href="/terms">Terms of Service</a> and
  <a href="/privacy">Privacy Policy</a>.
</p>`;

export const landingPage = (offer: PaidPlanOffer) =>
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
          ${signInConsent}
          <ul class="checks">
            ${check("Your first 5 reviews are on us")}
            ${check("Free with your own Gemini key")}
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
            html`Comment <code>/fletcher again</code> on a pull request to retry
              a failed review. Add
              <a href="/docs#config"><code>.fletcher.json</code></a> to tune
              what he looks at.`,
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
          <p>${pricingLede(offer)}</p>
        </div>
        <div class="plans">
          <div class="card plan plan-featured">
            <div class="plan-top">
              <h3>Bring your own key</h3>
              <span class="badge badge-brass">Free</span>
            </div>
            <p class="price">$0 <small>per workspace</small></p>
            <p>
              Unlimited reviews on your own Gemini key, with any current model
              it can use.
            </p>
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
          ${hostedPlanCard(offer)}
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
            html`To review a pull request, Fletcher sends its changes to the
            Gemini API from Google. He only reads repositories you install him
            on.`,
          )}
          ${feature(
            icon("key"),
            "Your key",
            html`Keys are checked with their provider before saving, stored
            encrypted, and never shown again in full.`,
          )}
          ${feature(
            icon("users"),
            "Your team",
            html`Roles follow GitHub. Owners choose admins, and you can remove
            Fletcher from GitHub at any time.`,
          )}
        </div>
        <p class="fine">
          The details are in our <a href="/privacy">Privacy Policy</a>.
        </p>
      </section>
      <section class="card cta">
        <div>
          <h2>Ready for rehearsal?</h2>
          <p>Sign in, install on a repository, and open a pull request.</p>
          ${signInConsent}
        </div>
        <a class="btn btn-lg" href="/auth/login"
          >${withGitHub("Sign in with GitHub")}</a
        >
      </section>`,
    null,
    { path: "/" },
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
      <a class="btn" href="/auth/login">${withGitHub("Sign in with GitHub")}</a>
      ${signInConsent}`,
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

const ownKeyStatus = (workspace: Workspace) =>
  `Reviews use this workspace's ${providerName(keyProvider(workspace))} key.`;

/** One line on the dashboard: whose key reviews use. */
const keyStatusLine = (workspace: Workspace, trialReviewsUsed: number) => {
  const trial = trialStatus(trialReviewsUsed);

  return workspace.geminiKeyLast4 !== null
    ? html`${icon("key")} <span class="quiet">${ownKeyStatus(workspace)}</span>`
    : trial.remaining > 0
      ? html`${trialMeter(trial.remaining, trial.total)}
          <span class="quiet"
            >${trial.remaining} of ${trial.total} free reviews left.</span
          >
          <a href="/workspaces/${workspace.id}/settings">Add your own key</a>`
      : html`${trialMeter(0, trial.total)}
          <span class="state-failed"
            >Free reviews used up. Reviews are paused.</span
          >
          <a href="/workspaces/${workspace.id}/settings">Add your own key</a>`;
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
              ${stat("Model tokens", formatNumber(overview.totals.totalTokens))}
            </div>
            ${overview.workspaces.map((workspace) =>
              workspaceSection(workspace, now),
            )}
            <p class="fine">
              ${formatNumber(overview.totals.reviewCount)}
              ${overview.totals.reviewCount === 1 ? "review" : "reviews"} so
              far, using ${formatNumber(overview.totals.totalTokens)} model
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
  | "model_saved"
  | "subscribed"
  | "invalid_format"
  | "wrong_provider"
  | "provider_disabled"
  | "rejected"
  | "unavailable"
  | "model_not_allowed"
  | "no_key"
  | "already_subscribed"
  | "no_billing_account"
  | "billing_unavailable"
  | "billing_disabled"
  | "confirmation_mismatch"
  | "subscription_renews"
  | "github_unavailable";

const noticeMessages = {
  saved: "Key saved. Reviews now use it.",
  removed: "Key removed.",
  model_saved: "Model saved. The next review uses it.",
  invalid_format:
    "That doesn't look like a key for the provider you chose. Paste only the key, with no spaces or quotes.",
  wrong_provider:
    "That's an Anthropic key. Choose Anthropic as the provider, then save it again.",
  provider_disabled: "Only Gemini keys are supported for now.",
  rejected:
    "The provider rejected that key. Check that it's active and allowed to use its API.",
  unavailable:
    "The provider didn't answer, so nothing was saved. Try again in a minute.",
  model_not_allowed: "That model isn't available here. Pick one from the list.",
  no_key: "Save a key before choosing its model.",
  subscribed:
    "Thanks for subscribing. The plan starts as soon as Polar confirms the payment, usually within a minute.",
  already_subscribed:
    "This workspace already has a subscription. Use Manage billing to change it or update its payment method.",
  no_billing_account:
    "This workspace has no billing account yet. Subscribe first.",
  billing_unavailable:
    "Polar didn't answer, so nothing changed. Try again in a minute.",
  billing_disabled: "Billing isn't set up on this server.",
  confirmation_mismatch:
    "That doesn't match this workspace's GitHub account name, so nothing was deleted.",
  subscription_renews:
    "This workspace's subscription still renews, so nothing was deleted. Cancel it in Manage billing first.",
  github_unavailable:
    "GitHub didn't answer, so Fletcher wasn't uninstalled and nothing was deleted. Try again in a minute.",
} as const satisfies Record<SettingsNotice, string>;

const settingsNotice = (notice: SettingsNotice | null) =>
  notice === null
    ? ""
    : notice === "saved" ||
        notice === "removed" ||
        notice === "model_saved" ||
        notice === "subscribed"
      ? html`<p class="notice" role="status">
          ${icon("check")}<span>${noticeMessages[notice]}</span>
        </p>`
      : html`<p class="notice notice-error" role="alert">
          ${icon("info")}<span>${noticeMessages[notice]}</span>
        </p>`;

const providerName = (provider: ReviewProvider): string =>
  Match.value(provider).pipe(
    Match.when("gemini_api", () => "Gemini API"),
    Match.when("vertex_express", () => "Vertex AI"),
    Match.when("openai", () => "OpenAI"),
    Match.when("anthropic", () => "Anthropic"),
    Match.exhaustive,
  );

const vendorName = (vendor: ModelVendor): string =>
  Match.value(vendor).pipe(
    Match.when("google", () => "Gemini"),
    Match.when("openai", () => "OpenAI"),
    Match.when("anthropic", () => "Anthropic"),
    Match.exhaustive,
  );

const keyProvider = (workspace: Workspace): ReviewProvider =>
  workspace.geminiKeyProvider ?? "gemini_api";

const ownKeyModel = (workspace: Workspace) =>
  workspace.reviewModel ?? DEFAULT_MODELS[vendorOf(keyProvider(workspace))];

const keySummary = (workspace: Workspace, trial: TrialStatus, now: Date) => {
  if (workspace.geminiKeyLast4 !== null) {
    return html`<div class="key-chip">
      <span class="feature-icon">${icon("key")}</span>
      <p>
        Reviews use this workspace's ${providerName(keyProvider(workspace))}
        key, ending in <span class="code">…${workspace.geminiKeyLast4}</span>,
        with <span class="code">${ownKeyModel(workspace)}</span>.
        ${
          workspace.geminiKeyUpdatedAt === null
            ? ""
            : html`Added ${relativeTime(workspace.geminiKeyUpdatedAt, now)}.`
        }
        ${
          hasPaidPlan(workspace, now)
            ? "Plan credits are spent first; this key takes over when they run out."
            : ""
        }
      </p>
    </div>`;
  }

  if (hasPaidPlan(workspace, now)) {
    return html`<div class="key-chip">
      <span class="feature-icon">${icon("key")}</span>
      <p>
        No key needed: the paid plan reviews on Fletcher's keys. Add your own to
        keep reviewing once the plan's credits run out.
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

/** Credits shown as people count them: 12.5, not 1250. */
const formatCredits = (creditsX100: number) =>
  Number((creditsX100 / 100).toFixed(2)).toString();

const creditsMeter = (
  workspace: Workspace,
  usedX100: number,
  allowance: number,
) => {
  const leftX100 = Math.max(0, allowance * 100 - usedX100);
  const periodEnd = workspace.subscriptionPeriodEnd;

  return html`<div class="key-chip" style="margin-top: 1rem">
    <span
      class="meter${leftX100 === 0 ? " meter-empty" : ""}"
      role="img"
      aria-label="${formatCredits(leftX100)} of ${allowance} review credits left"
      ><span
        style="width: ${leftX100 === 0 ? 100 : Math.round((leftX100 / (allowance * 100)) * 100)}%"
      ></span
    ></span>
    <p class="${leftX100 === 0 ? "state-failed" : ""}">
      ${formatCredits(usedX100)} of ${allowance} review credits used this
      period${periodEnd === null ? "" : html`, renewing ${isoDate(periodEnd)}`}.
    </p>
  </div>`;
};

const tierLabel = (tier: ModelTier) =>
  Match.value(tier).pipe(
    Match.when("lite", () => "Lite"),
    Match.when("standard", () => "Standard"),
    Match.when("pro", () => "Pro"),
    Match.when("excluded", () => "Own key only"),
    Match.exhaustive,
  );

/** Paid-plan models this server offers, grouped by tier. */
const planModelOptions = (
  selected: string,
  vendors: ReadonlySet<ModelVendor>,
) => {
  const offered = MODEL_CATALOG.filter(
    (model) => isPlanModel(model) && vendors.has(model.vendor),
  );

  return (["lite", "standard", "pro"] as const).map((tier) => {
    const models = offered.filter((model) => model.tier === tier);

    if (models.length === 0) {
      return "";
    }

    const weight = models[0]?.weight ?? 0;

    return html`<optgroup
      label="${tierLabel(tier)}: ${weight} credit${weight === 1 ? "" : "s"} a review, ${weight * LARGE_REVIEW_MULTIPLIER} for a large pull request"
    >
      ${models.map(
        (model) =>
          html`<option
            value="${model.id}"
            ${model.id === selected ? "selected" : ""}
          >
            ${model.id} (${vendorName(model.vendor)})
          </option>`,
      )}
    </optgroup>`;
  });
};

const planModelForm = (
  workspace: Workspace,
  vendors: ReadonlySet<ModelVendor>,
) => html`<form
  class="key-form"
  method="post"
  action="/workspaces/${workspace.id}/settings/plan-model"
>
  <label for="plan-model">Model for plan reviews</label>
  <select id="plan-model" name="model">
    ${planModelOptions(workspace.planModel ?? DEFAULT_PLAN_MODEL, vendors)}
  </select>
  <p class="fine">
    Large pull requests cost ${LARGE_REVIEW_MULTIPLIER} times as many credits.
    When credits run low, reviews switch to a smaller model from the same
    provider and say so. Once none fits, reviews use this workspace's own key if
    it has one, and stop otherwise until the plan renews.
  </p>
  <button class="btn btn-secondary" type="submit">Save model</button>
</form>`;

const planSummary = (workspace: Workspace, offer: PaidPlanOffer, now: Date) => {
  const periodEnd = workspace.subscriptionPeriodEnd;

  if (hasPaidPlan(workspace, now)) {
    return html`<p>
      <span class="badge badge-brass">${planName(offer)}</span>
      ${
        workspace.geminiKeyLast4 === null
          ? "Reviews spend the plan's credits on Fletcher's keys."
          : "Reviews spend the plan's credits first, then this workspace's own key."
      }
      ${
        periodEnd === null
          ? ""
          : workspace.subscriptionCancelAtPeriodEnd
            ? html`The plan ends on ${isoDate(periodEnd)}.`
            : html`Renews on ${isoDate(periodEnd)}.`
      }
    </p>`;
  }

  // Past due, unpaid, or a period that ended without a renewal.
  if (hasOpenSubscription(workspace)) {
    return html`<p class="state-failed">
      Polar hasn't confirmed this period's payment. Until it does, reviews use
      this workspace's key or free trial.
    </p>`;
  }

  if (!offer.billingEnabled) {
    return html`<p>
      Free: after the free trial, reviews use this workspace's own Gemini key.
    </p>`;
  }

  return html`<p>
    Free: after the free trial, reviews use this workspace's own Gemini key.
    ${planName(offer)}${Option.match(offer.price, {
      onNone: () => "",
      onSome: (price) => ` (${formatPrice(price)} per workspace)`,
    })}
    includes review credits each month on Fletcher's keys, with Gemini models to
    choose from. Polar handles payment, tax, and invoices.
  </p>`;
};

const planCard = (
  workspace: Workspace,
  canManage: boolean,
  offer: PaidPlanOffer,
  credits: {
    readonly usedX100: number;
    readonly allowance: number;
    readonly vendors: ReadonlySet<ModelVendor>;
  },
  now: Date,
) => {
  const subscribed = hasOpenSubscription(workspace);
  // A billing account can outlive the plan (canceled, or moved to another
  // product in the portal), and may still hold invoices or charges.
  const hasBillingAccount = workspace.polarCustomerId !== null;

  const action = (
    path: "portal" | "checkout",
    label: string,
    primary: boolean,
  ) =>
    html`<form
      method="post"
      action="/workspaces/${workspace.id}/billing/${path}"
    >
      <button class="btn${primary ? "" : " btn-secondary"}" type="submit">
        ${label}
      </button>
    </form>`;

  return html`<section class="card">
    <div class="card-head"><h2>Plan</h2></div>
    <div class="card-body">
      ${planSummary(workspace, offer, now)}
      ${
        hasPaidPlan(workspace, now)
          ? html`${creditsMeter(workspace, credits.usedX100, credits.allowance)}
            ${canManage ? planModelForm(workspace, credits.vendors) : ""}`
          : ""
      }
      ${
        !offer.billingEnabled
          ? ""
          : !canManage
            ? html`<p class="quiet" style="margin: 1rem 0 0">
                Only admins and owners can change the plan.
              </p>`
            : html`${
                subscribed
                  ? ""
                  : action(
                      "checkout",
                      Option.match(offer.price, {
                        onNone: () => "Subscribe",
                        onSome: (price) =>
                          `Subscribe for ${formatPrice(price)}`,
                      }),
                      true,
                    )
              }
              ${hasBillingAccount ? action("portal", "Manage billing", false) : ""}`
      }
    </div>
  </section>`;
};

const ownKeyModelForm = (
  workspace: Workspace,
  models: Option.Option<readonly string[]>,
) => {
  const current = workspace.reviewModel ?? "";
  const fallback = DEFAULT_MODELS[vendorOf(keyProvider(workspace))];

  return html`<form
    class="key-form"
    method="post"
    action="/workspaces/${workspace.id}/settings/review-model"
  >
    <label for="review-model">Model for reviews on this key</label>
    ${Option.match(models, {
      onNone: () =>
        html`<input
            id="review-model"
            name="model"
            value="${current}"
            placeholder="${fallback}"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="fine">
            The model list couldn't be loaded, so type a model ID, or leave it
            empty for ${fallback}.
          </p>`,
      onSome: (ids) =>
        html`<select id="review-model" name="model">
          <option value="" ${current === "" ? "selected" : ""}>
            Recommended: ${fallback}
          </option>
          ${ids.map(
            (id) =>
              html`<option value="${id}" ${id === current ? "selected" : ""}>
                ${id}
              </option>`,
          )}
        </select>`,
    })}
    <p class="fine">
      Any current model your key can use. Your provider bills these reviews to
      your account.
    </p>
    <button class="btn btn-secondary" type="submit">Save model</button>
  </form>`;
};

const providerChoice = (workspace: Workspace) => {
  const current =
    workspace.geminiKeyLast4 === null
      ? "google"
      : vendorOf(keyProvider(workspace));

  return html`<fieldset class="provider-choice">
    <legend>Provider</legend>
    ${(["openai", "anthropic", "google"] as const).flatMap((vendor) =>
      ENABLED_VENDORS.has(vendor)
        ? [
            html`<label
              ><input
                type="radio"
                name="vendor"
                value="${vendor}"
                ${vendor === current ? "checked" : ""}
              />
              ${vendorName(vendor)}</label
            >`,
          ]
        : [],
    )}
  </fieldset>`;
};

const deleteWorkspaceCard = (
  workspace: Workspace,
  viewerRole: WorkspaceRole,
) =>
  workspaceActionAllowed(viewerRole, "delete_workspace")
    ? html`<section class="card">
        <div class="card-head"><h2>Delete workspace data</h2></div>
        <div class="card-body">
          <p>
            Uninstalls Fletcher from ${workspace.githubAccountLogin} on GitHub
            and deletes this workspace's repositories, review history and
            findings, members and admins, audit history, and API key. It can't
            be undone.
          </p>
          <p class="fine">
            Fletcher keeps only the account's GitHub name and ID, its billing
            references, and the free reviews and plan credits it used, so
            installing again doesn't restart the trial. Reviews already posted
            on pull requests stay on GitHub. A subscription that still renews
            must be cancelled first.
          </p>
          <form
            class="key-form"
            method="post"
            action="/workspaces/${workspace.id}/delete"
          >
            <label for="confirm-workspace"
              >Type ${workspace.githubAccountLogin} to confirm</label
            >
            <input
              id="confirm-workspace"
              name="confirm"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              required
            />
            <button class="btn btn-danger" type="submit">
              Delete workspace data
            </button>
          </form>
        </div>
      </section>`
    : html`<p class="fine">
        An owner of ${workspace.githubAccountLogin} on GitHub can delete this
        workspace's data.
      </p>`;

export const settingsPage = (
  login: string,
  data: {
    readonly workspace: Workspace;
    readonly viewerRole: WorkspaceRole;
    readonly trial: TrialStatus;
    readonly offer: PaidPlanOffer;
    readonly creditsUsedX100: number;
    readonly creditAllowance: number;
    readonly planVendors: ReadonlySet<ModelVendor>;
    readonly ownKeyModels: Option.Option<readonly string[]>;
  },
  notice: SettingsNotice | null,
  now: Date,
) => {
  const { workspace, viewerRole, trial, offer } = data;
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
        "Choose the plan, key, and model Fletcher's reviews use.",
      )}
      ${settingsNotice(notice)}
      <div class="stack">
        ${planCard(
          workspace,
          canManage,
          offer,
          {
            usedX100: data.creditsUsedX100,
            allowance: data.creditAllowance,
            vendors: data.planVendors,
          },
          now,
        )}
        <section class="card">
          <div class="card-head"><h2>Your own key</h2></div>
          <div class="card-body">
            ${keySummary(workspace, trial, now)}
            ${
              canManage
                ? html`<form
                      class="key-form"
                      method="post"
                      action="/workspaces/${workspace.id}/settings/review-key"
                    >
                      ${providerChoice(workspace)}
                      <label for="api-key"
                        >${hasKey ? "New API key" : "API key"}</label
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
                        A Gemini API key from Google AI Studio, or a Vertex AI
                        API key. Fletcher checks it with the provider before
                        saving, stores it encrypted, and only ever shows its
                        last 4 characters. The provider bills reviews that use
                        it to your account.
                      </p>
                      <button class="btn" type="submit">
                        ${hasKey ? "Replace key" : "Save key"}
                      </button>
                    </form>
                    ${hasKey ? ownKeyModelForm(workspace, data.ownKeyModels) : ""}`
                : html`<p class="quiet" style="margin: 1rem 0 0">
                    Only admins and owners can change the key or model.
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
                    action="/workspaces/${workspace.id}/settings/review-key/remove"
                  >
                    <button class="btn btn-danger btn-sm" type="submit">
                      Remove key
                    </button>
                  </form>
                </div>
              </section>`
            : ""
        }
        ${deleteWorkspaceCard(workspace, viewerRole)}
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

const reviewToneChoices = [
  ["", "Follow .fletcher.json (standard if unset)"],
  ["standard", "Standard: businesslike, with the persona as seasoning"],
  ["ruthless", "Ruthless: full Fletcher, same findings and rubric"],
] as const;

/** Review tone for one repository; only admins and owners can change it. */
const reviewToneCard = (repository: GitHubRepository, canChange: boolean) => {
  const current = repository.reviewTone ?? "";

  return html`<section class="card">
    <div class="card-head"><h2>Review tone</h2></div>
    ${
      canChange
        ? html`<form
            class="key-form"
            method="post"
            action="/dashboard/repositories/${repository.id}/review-tone"
          >
            <label for="review-tone">Tone for this repository</label>
            <select id="review-tone" name="tone">
              ${reviewToneChoices.map(
                ([value, label]) =>
                  html`<option
                    value="${value}"
                    ${value === current ? "selected" : ""}
                  >
                    ${label}
                  </option>`,
              )}
            </select>
            <p class="fine">
              Applies to this repository only, from its next review. Tone
              changes the voice, never which findings are raised.
            </p>
            <button class="btn btn-secondary" type="submit">Save tone</button>
          </form>`
        : html`<p>
              ${reviewToneChoices.find(([value]) => value === current)?.[1] ?? ""}
            </p>
            <p class="fine">Ask an admin to change this.</p>`
    }
  </section>`;
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
    ${reviewToneCard(
      repository,
      repositoryActionAllowed(role, "set_review_tone"),
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
                      <dd>
                        ${run.model}${
                          run.requestedModel === null
                            ? ""
                            : ` (switched from ${run.requestedModel})`
                        }
                      </dd>
                    </div>`
              }
              ${
                run.creditsX100 === null || run.keySource !== "subscription"
                  ? ""
                  : html`<div>
                      <dt>Plan credits</dt>
                      <dd>${formatCredits(run.creditsX100)}</dd>
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

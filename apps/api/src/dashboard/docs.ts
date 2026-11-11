import { html } from "hono/html";

import { DAILY_REVIEW_RUN_CAP } from "../application/review-requests.js";
import { layout } from "./components.js";
import {
  CODEX_AUTH_WRITE_TOKEN_SECRET,
  codexRunnerWorkflowYaml,
  runnerWorkflowYaml,
} from "./runner-workflow.js";

// Every claim here mirrors code: the schema in
// packages/core/src/review-config.ts, the glob rules and built-in ignores in
// packages/core/src/diff.ts, repository context in
// apps/api/src/application/repository-context.ts, triggers in
// apps/api/src/github/. Update this
// page in the same change as any of them.

const EXAMPLE_CONFIG = `{
  "severityThreshold": "warning",
  "intensity": "carnegie",
  "ignore": [
    "*.md",
    "**/*.md",
    "**/__generated__/**",
    "fixtures/**"
  ]
}`;

const DEFAULT_CONFIG = `{
  "enabled": true,
  "severityThreshold": "suggestion",
  "intensity": "studio_band",
  "tone": "standard",
  "ignore": [],
  "guidelines": null
}`;

const OFF_CONFIG = `{ "enabled": false }`;

const codeBlock = (source: string) =>
  html`<pre class="docs-code"><code>${source}</code></pre>`;

const field = (
  name: string,
  values: string,
  fallback: string,
  description: ReturnType<typeof html>,
) =>
  html`<tr>
    <td><code>${name}</code></td>
    <td>${values}</td>
    <td><code>${fallback}</code></td>
    <td>${description}</td>
  </tr>`;

export const docsPage = (login: string | null) =>
  layout(
    "Docs",
    login,
    html`<article class="legal docs">
      <header class="page-head">
        <div>
          <span class="eyebrow">Docs</span>
          <h1 class="page-title">Setting Fletcher up</h1>
          <p class="lede">
            Install the GitHub App, then tune what Fletcher looks at with a
            <code>.fletcher.json</code> file in your repository.
          </p>
        </div>
      </header>

      <nav aria-label="On this page">
        <ul>
          <li><a href="#start">Get started</a></li>
          <li><a href="#triggers">When Fletcher reviews</a></li>
          <li><a href="#config">.fletcher.json</a></li>
          <li><a href="#ignore">Ignoring files</a></li>
          <li><a href="#context">What Fletcher reads</a></li>
          <li>
            <a href="#claude-subscription"
              >Reviews on your Claude subscription</a
            >
          </li>
          <li>
            <a href="#chatgpt-subscription">Reviews on your ChatGPT plan</a>
          </li>
          <li><a href="#gotchas">Things that catch people out</a></li>
        </ul>
      </nav>

      <h2 id="start">Get started</h2>
      <ol>
        <li>Sign in with GitHub.</li>
        <li>
          Install the Fletcher GitHub App on your account or organization, then
          pick the repositories it can see.
        </li>
        <li>
          Back in <a href="/onboarding">onboarding</a>, choose which
          repositories get reviews. Every repository you gave the App starts
          with reviews on; an admin can turn them off.
        </li>
        <li>
          Open a pull request. Each workspace gets 5 free reviews on Fletcher's
          key. After that, an admin adds a Gemini key in the workspace settings
          or subscribes to the paid plan (see <a href="/#pricing">pricing</a>).
        </li>
      </ol>
      <p>
        No <code>.fletcher.json</code> is needed. Without one, Fletcher uses the
        defaults below.
      </p>

      <h2 id="triggers">When Fletcher reviews</h2>
      <ul>
        <li>
          When a pull request is opened or reopened, or when new commits are
          pushed to it. On a new push, Fletcher remembers what he said last
          time.
        </li>
        <li>
          Only when the pull request's author is an owner, member, or
          collaborator on the repository. Pull requests from anyone else, such
          as outside contributors' forks, aren't reviewed on their own.
        </li>
        <li>
          On demand: an owner, member, or collaborator comments
          <code>/fletcher again</code> on the pull request. Fletcher reviews the
          latest commit if it hasn't been reviewed yet (for example, an outside
          contributor's pull request), or retries a review that failed. Admins
          and owners can also press <strong>Retry review</strong> on a failed
          review's page in the dashboard, which does the same.
        </li>
      </ul>
      <p>
        Fletcher reviews each commit once. <code>/fletcher again</code> on a
        commit that already has a review doesn't start another one; push a new
        commit to get a new review.
      </p>

      <h3 id="fletcher-again">How Fletcher answers /fletcher again</h3>
      <p>
        Fletcher answers every <code>/fletcher again</code> from an owner,
        member, or collaborator, so you can tell it was heard:
      </p>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">What's happening</th>
              <th scope="col">Fletcher's answer</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                A review starts now, or the commit's review is already queued or
                running
              </td>
              <td>👀 reaction on your comment</td>
            </tr>
            <tr>
              <td>The latest commit already has a finished review</td>
              <td>👍 reaction; nothing new to review</td>
            </tr>
            <tr>
              <td>
                The account hit its limit of ${DAILY_REVIEW_RUN_CAP} reviews in
                24 hours
              </td>
              <td>A reply asking you to try again later</td>
            </tr>
            <tr>
              <td>Reviews are off for this repository</td>
              <td>No answer</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Comments from anyone else are ignored without an answer.</p>
      <p>
        Reviews are posted as comments. Fletcher never approves or blocks a pull
        request, so branch protection rules don't change.
      </p>

      <h2 id="config">.fletcher.json</h2>
      <p>
        Put <code>.fletcher.json</code> at the root of the repository. Fletcher
        reads it from the <strong>default branch</strong>, never from the pull
        request, so a pull request can't turn its own review off or hide files.
        Changes to the file take effect once they're merged.
      </p>
      <p>Every field is optional. A typical file:</p>
      ${codeBlock(EXAMPLE_CONFIG)}

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Values</th>
              <th scope="col">Default</th>
              <th scope="col">What it does</th>
            </tr>
          </thead>
          <tbody>
            ${field(
              "enabled",
              "true, false",
              "true",
              html`<code>false</code> skips reviews for this repository. The
                dashboard shows them as skipped.`,
            )}
            ${field(
              "severityThreshold",
              "critical, warning, suggestion",
              '"suggestion"',
              html`The lowest severity that gets posted.
                <code>"warning"</code> posts critical and warning findings;
                <code>"critical"</code> posts only critical ones. The verdict
                isn't affected.`,
            )}
            ${field(
              "intensity",
              "sectional, studio_band, carnegie",
              '"studio_band"',
              html`How hard Fletcher looks. <code>sectional</code> is terse and
                businesslike. <code>carnegie</code> holds the change to the
                highest standard: naming, edge cases, and tests.`,
            )}
            ${field(
              "tone",
              "standard, ruthless",
              '"standard"',
              html`How Fletcher words things. It never changes which findings
              are raised. A tone set on the repository's dashboard page wins
              over this field.`,
            )}
            ${field(
              "ignore",
              "array of globs",
              "[]",
              html`Files left out of the review. See
                <a href="#ignore">Ignoring files</a>.`,
            )}
            ${field(
              "guidelines",
              "array of paths or globs, null",
              "null",
              html`The files that hold your review rules, read from the default
                branch. <code>null</code> uses the usual places. See
                <a href="#context">What Fletcher reads</a>.`,
            )}
          </tbody>
        </table>
      </div>

      <p>The defaults, written out in full:</p>
      ${codeBlock(DEFAULT_CONFIG)}
      <p>To turn reviews off for a repository:</p>
      ${codeBlock(OFF_CONFIG)}

      <h2 id="ignore">Ignoring files</h2>
      <p>
        Each glob is matched against the file's full path from the repository
        root, with no leading <code>/</code> or <code>./</code>:
        <code>/docs/**</code> matches nothing.
      </p>
      <ul>
        <li>
          <code>*</code> and <code>?</code> stay inside one folder:
          <code>*.md</code> matches <code>README.md</code> but not
          <code>docs/guide.md</code>.
        </li>
        <li>
          <code>**</code> crosses folders: <code>docs/**</code> matches
          everything under <code>docs/</code>.
        </li>
        <li>
          <code>**/*.md</code> needs at least one folder, so it doesn't match
          <code>README.md</code> at the root. To match a file type everywhere,
          list both <code>*.md</code> and <code>**/*.md</code>.
        </li>
        <li>
          Braces (<code>{a,b}</code>), character classes (<code>[ab]</code>),
          and negation (<code>!</code>) aren't supported and match literally.
        </li>
      </ul>
      <p>These are always ignored, with or without a config file:</p>
      <ul>
        <li>
          Lockfiles: <code>pnpm-lock.yaml</code>,
          <code>package-lock.json</code>, <code>yarn.lock</code>,
          <code>bun.lock</code>, <code>bun.lockb</code>
        </li>
        <li>Minified files: <code>*.min.js</code>, <code>*.min.css</code></li>
        <li>
          Images, PDFs, and web fonts (<code>png</code>, <code>jpg</code>,
          <code>jpeg</code>, <code>gif</code>, <code>webp</code>,
          <code>ico</code>, <code>pdf</code>, <code>woff</code>,
          <code>woff2</code>)
        </li>
        <li>Test snapshots (<code>*.snap</code>)</li>
        <li>
          <code>.sql</code> files and <code>meta/</code> inside any
          <code>drizzle/</code> folder, and
          <code>worker-configuration.d.ts</code>
        </li>
      </ul>
      <p>
        Nothing else is ignored by default, including other ecosystems'
        lockfiles (<code>Cargo.lock</code>, <code>go.sum</code>,
        <code>poetry.lock</code>) and SVGs. Add those to <code>ignore</code>
        if you don't want them reviewed.
      </p>

      <h2 id="context">What Fletcher reads</h2>
      <p>Besides the diff, each review gets:</p>
      <ul>
        <li>
          <strong>Your rules.</strong> <code>AGENTS.md</code>,
          <code>CLAUDE.md</code>, <code>CONTRIBUTING.md</code>,
          <code>.github/CONTRIBUTING.md</code>,
          <code>docs/CONTRIBUTING.md</code>, and
          <code>.github/copilot-instructions.md</code>, plus any
          <code>AGENTS.md</code> or <code>CLAUDE.md</code> in a folder the pull
          request changes. They're read from the default branch, so a pull
          request can't rewrite the rules it's reviewed against. Up to 8 files
          and 40 KB in total. Set <code>guidelines</code> to pick the files
          yourself, for example <code>["docs/style/**"]</code>.
        </li>
        <li>
          <strong>Your dependencies.</strong> The root manifest
          (<code>package.json</code>, <code>go.mod</code>,
          <code>pyproject.toml</code>, <code>Cargo.toml</code>, and the like)
          and the nearest one to each changed file, so library versions newer
          than the model's training aren't flagged as mistakes.
        </li>
        <li>
          <strong>The changed files in full</strong>, as they are in the pull
          request, so code just outside the diff counts. Up to 25 files and 150
          KB, most-changed first; files over 60 KB are reviewed from the diff
          only.
        </li>
      </ul>
      <p>
        Findings that cite a rule quote it and name its file. Fletcher still
        comments only on lines the pull request adds, and these files don't
        count toward the 300 KB diff limit or your credits.
      </p>

      <h2 id="claude-subscription">Reviews on your Claude subscription</h2>
      <p>
        A repository can review on your own Claude Pro, Max or Ultra plan
        instead of a review key or plan credits. Its GitHub Actions run Claude
        Code, Anthropic's official CLI, with your token, and send Fletcher the
        review to post. Fletcher never sees the token, and these reviews use no
        credits.
      </p>
      <ol>
        <li>
          On the repository's page in the dashboard, set
          <strong>Where reviews run</strong> to your Claude subscription.
        </li>
        <li>
          On your machine, run <code>claude setup-token</code> and approve it on
          claude.ai. It prints a token that lasts a year.
        </li>
        <li>
          Save it as a secret on the repository:
          <code>gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/name</code>.
          Paste it into your terminal, not into Fletcher.
        </li>
        <li>
          Commit this workflow to the default branch, under exactly this name:
        </li>
      </ol>
      ${codeBlock(runnerWorkflowYaml())}
      <ul>
        <li>
          <strong>Pull requests from forks aren't reviewed.</strong> GitHub
          keeps secrets from their runs, and only
          <code>fletcher-review.yml</code> running on <code>pull_request</code>
          can fetch a review.
        </li>
        <li>
          <strong>The token is one person's plan.</strong> Anthropic sizes
          subscription limits for ordinary individual use. For a team, set
          <code>ANTHROPIC_API_KEY</code> in the review step instead of
          <code>CLAUDE_CODE_OAUTH_TOKEN</code>.
        </li>
        <li>
          <strong>Each review takes about a minute of Actions time.</strong>
          If the workflow doesn't report back within 30 minutes, the review
          fails and the dashboard says why.
        </li>
      </ul>

      <h2 id="chatgpt-subscription">Reviews on your ChatGPT plan</h2>
      <p>
        A repository can review with GPT models on your ChatGPT plan instead of
        a review key or plan credits. Its GitHub Actions run Codex, OpenAI's
        official CLI, signed in as you, and send Fletcher the review to post.
        Fletcher never sees your sign-in, and these reviews use no credits.
      </p>
      <ol>
        <li>
          On the repository's page in the dashboard, set
          <strong>Where reviews run</strong> to your ChatGPT plan, and pick a
          GPT model if you want another than the default.
        </li>
        <li>
          Give the repository one way to sign in:
          <ul>
            <li>
              <strong>ChatGPT Business or Enterprise:</strong> create a Codex
              access token in Codex's settings (your workspace admin has to
              allow them) and save it:
              <code>gh secret set CODEX_ACCESS_TOKEN --repo owner/name</code>.
            </li>
            <li>
              <strong>ChatGPT Plus or Pro:</strong> on your machine, set
              <code>cli_auth_credentials_store = "file"</code> in
              <code>~/.codex/config.toml</code>, run <code>codex login</code>,
              then save the file it writes:
              <code
                >gh secret set CODEX_AUTH_JSON --repo owner/name &lt;
                ~/.codex/auth.json</code
              >. Codex rotates this sign-in about every 8 days, so the workflow
              refreshes it every 3 days and saves the new copy. That needs a
              fine-grained personal access token for this repository alone with
              <strong>Secrets: read and write</strong>, saved as
              <code>${CODEX_AUTH_WRITE_TOKEN_SECRET}</code>. Then run
              <code>codex logout</code> on your machine, or keep using a
              different sign-in there: two copies of one sign-in rotate each
              other out.
            </li>
          </ul>
        </li>
        <li>
          Commit this workflow to the default branch, under exactly this name.
          It replaces the Claude one; a repository has one or the other.
        </li>
      </ol>
      ${codeBlock(codexRunnerWorkflowYaml())}
      <ul>
        <li>
          <strong>Only for private repositories.</strong> OpenAI asks that a
          ChatGPT sign-in not be used for public or open-source repositories.
          Pull requests from forks aren't reviewed either way.
        </li>
        <li>
          <strong>Codex can read the checkout, not your sign-in.</strong> It
          runs read-only, its sign-in folder is unreadable to the commands it
          runs, and the pull request's own <code>AGENTS.md</code> isn't loaded.
        </li>
        <li>
          <strong>If reviews start failing to sign in,</strong> the stored
          sign-in was rotated somewhere else. Run <code>codex login</code> and
          save <code>CODEX_AUTH_JSON</code> again.
        </li>
        <li>
          <strong>The plan is one person's.</strong> Reviews count toward your
          Codex usage limits. If the workflow doesn't report back within 30
          minutes, the review fails and the dashboard says why.
        </li>
      </ul>

      <h2 id="gotchas">Things that catch people out</h2>
      <ul>
        <li>
          <strong>One bad value resets everything.</strong> If the file isn't
          valid JSON, or any field has a value not listed above, Fletcher
          ignores the whole file and uses the defaults, including
          <code>"enabled": true</code> and no ignores. Nothing is posted about
          it, so check the file carefully.
        </li>
        <li>
          <strong>Plain JSON only.</strong> No comments and no trailing commas.
        </li>
        <li>
          <strong>Misspelled fields are skipped without a warning.</strong>
          <code>"severity"</code> or <code>"ignored"</code> does nothing.
        </li>
        <li>
          <strong>Very large pull requests aren't reviewed.</strong> The limit
          is 300 KB of diff, and it counts every file, including ignored ones
          and lockfiles. Split big changes, or move large generated changes into
          their own pull request.
        </li>
        <li>
          <strong
            >Edits in a pull request don't apply to that pull request.</strong
          >
          Merge the change to <code>.fletcher.json</code> first. Commits
          Fletcher has already reviewed or skipped stay that way; the new
          settings apply from the next push.
        </li>
      </ul>
    </article>`,
    null,
    {
      description:
        "Set up Fletcher, the pull request reviewer from Not Quite My Tempo: " +
        "install the GitHub App, pick a model, and tune reviews with .fletcher.json.",
      path: "/docs",
    },
  );

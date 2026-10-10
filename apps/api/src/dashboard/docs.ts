import { html } from "hono/html";

import { layout } from "./components.js";

// Every claim here mirrors code: the schema in
// packages/core/src/review-config.ts, the glob rules and built-in ignores in
// packages/core/src/diff.ts, triggers in apps/api/src/github/. Update this
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
  "ignore": []
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
          contributor's pull request), or retries a review that failed.
        </li>
      </ul>
      <p>
        Fletcher reviews each commit once. <code>/fletcher again</code> on a
        commit that already has a review does nothing; push a new commit to get
        a new review.
      </p>
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
  );

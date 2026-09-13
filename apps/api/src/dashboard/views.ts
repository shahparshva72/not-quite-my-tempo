import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  Finding,
  GitHubRepository,
  ReviewRun,
} from "@not-quite-my-tempo/db";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface RepositoryUsageRow {
  readonly repositoryId: number;
  readonly fullName: string;
  readonly runCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

const styles = `
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 2rem; background: #131013; color: #e8e2d9;
    font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  main { max-width: 64rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; letter-spacing: 0.02em; }
  h1 a { color: inherit; text-decoration: none; }
  h1 .drum { margin-right: 0.5rem; }
  h2 { font-size: 1rem; margin-top: 2rem; }
  a { color: #d9a441; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td {
    text-align: left; padding: 0.45rem 0.75rem;
    border-bottom: 1px solid #2c262c; vertical-align: top;
  }
  th { color: #9a8f85; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .status-completed { color: #7fb069; }
  .status-failed { color: #d9534f; }
  .status-running, .status-queued { color: #d9a441; }
  .severity-critical { color: #d9534f; font-weight: 700; }
  .severity-warning { color: #d9a441; }
  .severity-suggestion { color: #9a8f85; }
  .meta { color: #9a8f85; font-size: 0.85rem; }
  .signin {
    display: inline-block; margin-top: 1.5rem; padding: 0.6rem 1.2rem;
    background: #d9a441; color: #131013; text-decoration: none;
    font-weight: 700; border-radius: 4px;
  }
  nav { margin-bottom: 0.5rem; }
`;

const layout = (title: string, content: HtmlContent) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title} · Not Quite My Tempo</title>
      <style>
        ${styles}
      </style>
    </head>
    <body>
      <main>
        <h1>
          <span class="drum">🥁</span
          ><a href="/dashboard">Not Quite My Tempo</a>
        </h1>
        ${content}
      </main>
    </body>
  </html>`;

export const landingPage = () =>
  layout(
    "Sign in",
    html`<p>
        Fletcher reviews your pull requests. He is not gentle, but he is right.
      </p>
      <a class="signin" href="/auth/login">Sign in with GitHub</a>`,
  );

export const notFoundPage = () =>
  layout(
    "Not found",
    html`<p>Not my chart. <a href="/dashboard">Back to the band.</a></p>`,
  );

const formatDate = (date: Date) =>
  date.toISOString().replace("T", " ").slice(0, 16);

export const dashboardPage = (
  login: string,
  usage: readonly RepositoryUsageRow[],
) =>
  layout(
    "Repositories",
    html`<p class="meta">
        Signed in as ${login} · <a href="/auth/logout">sign out</a>
      </p>
      <h2>Repositories</h2>
      ${
        usage.length === 0
          ? html`<p>No repositories yet. Install the GitHub App on one.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th class="num">Runs</th>
                  <th class="num">Input tokens</th>
                  <th class="num">Output tokens</th>
                  <th class="num">Total tokens</th>
                </tr>
              </thead>
              <tbody>
                ${usage.map(
                  (row) =>
                    html`<tr>
                      <td>
                        <a href="/dashboard/repositories/${row.repositoryId}">
                          ${row.fullName}
                        </a>
                      </td>
                      <td class="num">${row.runCount}</td>
                      <td class="num">${row.inputTokens}</td>
                      <td class="num">${row.outputTokens}</td>
                      <td class="num">${row.totalTokens}</td>
                    </tr>`,
                )}
              </tbody>
            </table>`
      }`,
  );

export const repositoryRunsPage = (
  repository: GitHubRepository,
  runs: readonly ReviewRun[],
) =>
  layout(
    repository.fullName,
    html`<nav class="meta"><a href="/dashboard">← repositories</a></nav>
      <h2>${repository.fullName}</h2>
      ${
        runs.length === 0
          ? html`<p>No review runs yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>PR</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Model</th>
                  <th class="num">Tokens</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) =>
                    html`<tr>
                      <td>
                        <a href="/dashboard/runs/${run.id}">#${run.id}</a>
                      </td>
                      <td>#${run.pullRequestNumber}</td>
                      <td>${run.trigger}</td>
                      <td class="status-${run.status}">${run.status}</td>
                      <td>${run.errorCode ?? ""}</td>
                      <td>${run.model ?? ""}</td>
                      <td class="num">${run.totalTokens ?? ""}</td>
                      <td class="meta">${formatDate(run.createdAt)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>`
      }`,
  );

export const runFindingsPage = (run: ReviewRun, findings: readonly Finding[]) =>
  layout(
    `Run #${run.id}`,
    html`<nav class="meta">
        <a href="/dashboard/repositories/${run.repositoryId}">← runs</a>
      </nav>
      <h2>Run #${run.id} · PR #${run.pullRequestNumber}</h2>
      <p class="meta">
        ${run.headSha} · ${run.trigger} ·
        <span class="status-${run.status}">${run.status}</span>
        ${run.errorCode === null ? "" : html` · ${run.errorCode}`}
        ${run.model === null ? "" : html` · ${run.model}`}
      </p>
      ${
        findings.length === 0
          ? html`<p>No findings. ...Good job.</p>`
          : html`<table>
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
                      <td>
                        ${finding.filePath}${finding.line === null ? "" : `:${finding.line}`}
                      </td>
                      <td>
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
            </table>`
      }`,
  );

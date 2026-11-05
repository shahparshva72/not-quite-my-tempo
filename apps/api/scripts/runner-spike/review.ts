/**
 * Spike for reviews that run on the user's Claude subscription inside their
 * own GitHub Actions. It builds the bundle a runner would claim from Fletcher
 * (the production prompt, repository context and `.fletcher.json` settings),
 * runs the official Claude Code CLI over a checkout of the pull request head
 * the way `anthropics/claude-code-action` would, and prints the review as
 * Fletcher would post it. Nothing is posted and no Fletcher credits are used:
 * the model call bills to whoever is signed in to the local `claude`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Effect, Option, Schema } from "effect";
import {
  commentableLinesByFile,
  defaultReviewConfig,
  filterUnifiedDiff,
  parseUnifiedDiff,
  REVIEW_CONFIG_PATH,
  ReviewConfig,
} from "@not-quite-my-tempo/core";
import type { Finding } from "@not-quite-my-tempo/db";
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
  filterReviewBySeverity,
  GeminiReview,
  reviewJsonSchema,
} from "@not-quite-my-tempo/reviewer";
import type { GeminiReviewInput } from "@not-quite-my-tempo/reviewer";

import { fetchRepositoryContext } from "../../src/application/repository-context.js";
import {
  buildFindingCommentBody,
  buildReviewSummaryBody,
} from "../../src/application/review-presentation.js";
import {
  GitHubPullRequestClient,
  GitHubPullRequestClientLive,
} from "../../src/github/pull-request-client.js";
import type { PullRequestRef } from "../../src/github/pull-request-client.js";

const usage = `Usage: pnpm --filter @not-quite-my-tempo/api spike:claude-review \\
  --pr <owner/repo#number | pull request URL> [options]

  --config <path>     Use this local .fletcher.json instead of the one on the
                      repository's default branch
  --model <id>        Claude model for Claude Code (default claude-sonnet-5-5)
  --max-turns <n>     Claude Code turn cap (default 20)
  --workdir <dir>     Where to check out the pull request head
                      (default: a folder under the OS temp directory)
  --no-context        Review the diff alone, without repository context
  --bundle-only       Write the bundle and stop before calling Claude Code

Env: GITHUB_TOKEN (falls back to \`gh auth token\`). Claude Code runs on your
local \`claude\` login; ANTHROPIC_API_KEY is removed from its environment so
the subscription, not an API key, pays.`;

const { values: args } = parseArgs({
  options: {
    pr: { type: "string" },
    config: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    "max-turns": { type: "string", default: "20" },
    workdir: { type: "string" },
    "no-context": { type: "boolean", default: false },
    "bundle-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
};

if (args.help) {
  console.log(usage);
  process.exit(0);
}

const PULL_REQUEST =
  /^(?:https:\/\/github\.com\/)?([^/#\s]+)\/([^/#\s]+)(?:#|\/pull\/)(\d+)\/?$/;

const parsePullRequest = (value: string): PullRequestRef => {
  const match = PULL_REQUEST.exec(value);

  return match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
    ? fail(`--pr "${value}" is not owner/repo#number or a pull request URL.`)
    : { owner: match[1], repo: match[2], pullRequestNumber: Number(match[3]) };
};

const ref = parsePullRequest(args.pr ?? fail("--pr is required."));

const maxTurns = Number(args["max-turns"]);

if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
  fail(`--max-turns must be a positive integer, got "${args["max-turns"]}".`);
}

const slug = `${ref.owner}/${ref.repo}#${ref.pullRequestNumber}`;

const workdir =
  args.workdir ??
  join(
    tmpdir(),
    "fletcher-runner-spike",
    `${ref.owner}-${ref.repo}-${ref.pullRequestNumber}`,
  );

// Beside the checkout, not in it: Claude Code must not find the bundle with
// its file tools (see the note on runClaudeCode).
const bundleDir = `${workdir}.fletcher`;

const gh = (...ghArgs: readonly string[]) =>
  execFileSync("gh", ghArgs, { encoding: "utf8" }).trim();

const githubToken = process.env["GITHUB_TOKEN"] ?? gh("auth", "token");

const defaultBranch = gh(
  "api",
  `repos/${ref.owner}/${ref.repo}`,
  "--jq",
  ".default_branch",
);

// What a runner would get back from POST /runner/v1/claim: production's
// prompt for this pull request under the repository's .fletcher.json.
const loadConfig = (content: Option.Option<string>, source: string) =>
  Option.match(content, {
    onNone: () =>
      Effect.sync(() => {
        console.log(`No ${REVIEW_CONFIG_PATH} (${source}); using defaults.`);

        return defaultReviewConfig;
      }),
    onSome: (json) =>
      Schema.decodeUnknown(Schema.parseJson(ReviewConfig))(json).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            console.log(`Using ${REVIEW_CONFIG_PATH} from ${source}.`),
          ),
        ),
        // Production logs and falls back the same way.
        Effect.catchTag("ParseError", (error) =>
          Effect.sync(() => {
            console.warn(
              `${REVIEW_CONFIG_PATH} from ${source} is invalid; using defaults.\n${error.message}`,
            );

            return defaultReviewConfig;
          }),
        ),
      ),
  });

const buildBundle = Effect.gen(function* () {
  const client = yield* GitHubPullRequestClient;

  const details = yield* client.fetchDetails(githubToken, ref);

  const configFile =
    args.config === undefined
      ? yield* client.fetchRepositoryFile(
          githubToken,
          ref,
          REVIEW_CONFIG_PATH,
          defaultBranch,
        )
      : Option.some(readFileSync(args.config, "utf8"));

  const config = yield* loadConfig(
    configFile,
    args.config ?? `${defaultBranch} on GitHub`,
  );

  const diff = filterUnifiedDiff(
    yield* client.fetchDiff(githubToken, ref),
    config.ignore,
  );

  const context = args["no-context"]
    ? null
    : yield* fetchRepositoryContext({
        installationToken: githubToken,
        ref,
        defaultBranch,
        headSha: details.headSha,
        diff,
        guidelines: config.guidelines,
      });

  const input: GeminiReviewInput = {
    repository: `${ref.owner}/${ref.repo}`,
    pullRequestNumber: ref.pullRequestNumber,
    title: details.title,
    body: details.body,
    diff,
    priorReview: null,
    context,
    intensity: config.intensity,
    tone: config.tone,
  };

  return { config, details, diff, input };
});

// Fletcher's system prompt, appended to Claude Code's own so its tool
// guidance stays, plus where the review runs.
const systemPrompt = (input: GeminiReviewInput) =>
  [
    buildSystemPrompt(input.intensity, input.tone),
    "",
    "## Where you are running",
    "",
    "Your working directory is a checkout of this pull request's head commit.",
    "Use Read, Grep and Glob to check a suspected problem against the code",
    "before reporting it. Line numbers are always the file's own line",
    "numbers at this commit, as the diff's new side and Read show them.",
    "Return only the review object.",
  ].join("\n");

const checkout = (headSha: string) => {
  if (!existsSync(join(workdir, ".git"))) {
    mkdirSync(workdir, { recursive: true });
    gh(
      "repo",
      "clone",
      `${ref.owner}/${ref.repo}`,
      workdir,
      "--",
      "--depth",
      "1",
      "--no-checkout",
    );
  }

  const git = (...gitArgs: readonly string[]) =>
    execFileSync("git", ["-C", workdir, ...gitArgs], { stdio: "ignore" });

  git("fetch", "--depth", "1", "origin", `pull/${ref.pullRequestNumber}/head`);
  git("checkout", "--force", "--detach", "FETCH_HEAD");

  const checkedOut = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  if (checkedOut !== headSha) {
    console.warn(
      `Checked out ${checkedOut}, but GitHub reports head ${headSha}.`,
    );
  }
};

// Mirrors the planned workflow step: read-only tools, structured output, no
// MCP servers, and none of the local user's settings, hooks or plugins (a
// runner has none). Project settings in the checkout still load, as they
// would on a runner.
const claudeArgs = (system: string): readonly string[] => [
  "-p",
  "--append-system-prompt",
  system,
  "--output-format",
  "json",
  "--json-schema",
  JSON.stringify(reviewJsonSchema),
  "--tools",
  "Read,Grep,Glob",
  "--allowedTools",
  "Read,Grep,Glob",
  "--permission-mode",
  "dontAsk",
  "--max-turns",
  String(maxTurns),
  "--model",
  args.model,
  "--setting-sources",
  "project",
  "--strict-mcp-config",
  "--no-session-persistence",
];

// The pull request prompt goes in on stdin (it can pass Linux's 128 KiB
// limit for one argument). An earlier version wrote it to a file in the
// checkout for Claude Code to Read; findings then cited that file's line
// numbers instead of the source's, so none could anchor to the diff.
const runClaudeCode = (system: string, prompt: string) =>
  Effect.async<string, Error>((resume) => {
    // An API key outranks the subscription login, so it must not leak in.
    const { ANTHROPIC_API_KEY: _apiKey, ...inherited } = process.env;

    const env = { ...inherited, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

    const child = spawn("claude", claudeArgs(system), {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const chunks: Buffer[] = [];

    child.stdin.end(prompt);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => resume(Effect.fail(error)));
    child.on("close", () =>
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))),
    );

    return Effect.sync(() => child.kill());
  });

// The fields of Claude Code's `--output-format json` result read here.
const ClaudeCodeResult = Schema.Struct({
  subtype: Schema.String,
  is_error: Schema.Boolean,
  num_turns: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  total_cost_usd: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
});

const toFindings = (review: GeminiReview): readonly Finding[] =>
  review.findings.map((finding, index) => ({
    id: index + 1,
    reviewRunId: 0,
    filePath: finding.filePath,
    line: finding.line,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence,
    title: finding.title,
    message: finding.message,
    githubCommentId: null,
    createdAt: new Date(0),
  }));

/** The review as Fletcher would post it (see postReviewToGitHub). */
const presentReview = (review: GeminiReview, diff: string) => {
  const findings = toFindings(review);
  const commentable = commentableLinesByFile(parseUnifiedDiff(diff));

  const isAnchored = (finding: Finding) =>
    finding.line !== null &&
    (commentable.get(finding.filePath)?.has(finding.line) ?? false);

  const summary = buildReviewSummaryBody(
    review,
    findings,
    findings.filter((finding) => !isAnchored(finding)),
    "standard",
  );

  const inline = findings
    .filter(isAnchored)
    .map(
      (finding) =>
        `### ${finding.filePath}:${finding.line ?? ""}\n\n${buildFindingCommentBody(finding)}`,
    );

  return [
    `## Review summary\n\n${summary}`,
    `## Inline comments (${inline.length})`,
    ...inline,
  ].join("\n\n");
};

const program = Effect.gen(function* () {
  console.log(`Building the runner bundle for ${slug}…`);

  const { config, details, diff, input } = yield* buildBundle;

  console.log(
    `intensity=${config.intensity} tone=${config.tone} ` +
      `severityThreshold=${config.severityThreshold} ` +
      `ignore=${config.ignore.length} context=${input.context !== null}`,
  );

  checkout(details.headSha);
  mkdirSync(bundleDir, { recursive: true });
  const system = systemPrompt(input);
  const prompt = buildReviewUserPrompt(input);

  writeFileSync(join(bundleDir, "system.md"), system);
  writeFileSync(join(bundleDir, "prompt.md"), prompt);
  writeFileSync(
    join(bundleDir, "schema.json"),
    `${JSON.stringify(reviewJsonSchema, null, 2)}\n`,
  );

  console.log(`Bundle written to ${bundleDir}.`);

  if (args["bundle-only"]) {
    return;
  }

  console.log(
    `Running Claude Code (${args.model}, up to ${maxTurns} turns) in ${workdir}…`,
  );

  const raw = yield* runClaudeCode(system, prompt);

  writeFileSync(join(bundleDir, "result.json"), raw);

  const result = yield* Schema.decodeUnknown(
    Schema.parseJson(ClaudeCodeResult),
  )(raw);

  console.log(
    `Claude Code: ${result.subtype}, ${result.num_turns ?? "?"} turns, ` +
      `${((result.duration_ms ?? 0) / 1_000).toFixed(0)}s` +
      (result.total_cost_usd === undefined
        ? ""
        : `, $${result.total_cost_usd.toFixed(4)} API-equivalent`),
  );

  if (result.is_error || result.structured_output === undefined) {
    return yield* Effect.fail(
      new Error(
        `Claude Code returned no review (${result.subtype}): ${result.result ?? "no message"}`,
      ),
    );
  }

  const review = filterReviewBySeverity(
    yield* Schema.decodeUnknown(GeminiReview)(result.structured_output),
    config.severityThreshold,
  );

  const markdown = presentReview(review, diff);

  writeFileSync(join(bundleDir, "review.md"), `${markdown}\n`);

  console.log(
    `\n${markdown}\n\nVerdict ${review.verdict}, ${review.findings.length} finding(s). ` +
      `Saved to ${join(bundleDir, "review.md")}.`,
  );
});

await Effect.runPromise(
  program.pipe(Effect.provide(GitHubPullRequestClientLive({}))),
);

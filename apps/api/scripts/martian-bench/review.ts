/**
 * Runs Fletcher over Martian's offline code review benchmark
 * (github.com/withmartian/code-review-benchmark) and writes each review into
 * its `results/benchmark_data.json` as one more tool, ready for the
 * benchmark's own extract → dedup → judge steps. See README.md here.
 *
 * Each review takes the production path: the same diff filter, repository
 * context, prompt, model call, and GitHub comment formatting. Only the
 * webhook, the database, and the GitHub post itself are skipped.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Effect, Layer, Match, Option, Ref, Schema } from "effect";
import {
  commentableLinesByFile,
  filterUnifiedDiff,
  parseUnifiedDiff,
} from "@not-quite-my-tempo/core";
import type { Finding } from "@not-quite-my-tempo/db";
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
  findCatalogModel,
  Reviewer,
  ReviewerLive,
  reviewCostUsdMicros,
  verdictForFindings,
} from "@not-quite-my-tempo/reviewer";
import type {
  CatalogModel,
  GeminiReview,
  GeminiReviewInput,
  ReviewerConfig,
  ReviewStrategy,
  ReviewUsage,
} from "@not-quite-my-tempo/reviewer";

import { fetchRepositoryContext } from "../../src/application/repository-context.js";
import { withVertexProject } from "../../src/application/review-keys.js";
import type { ResolvedReviewKey } from "../../src/application/review-keys.js";
import {
  buildFindingCommentBody,
  buildReviewSummaryBody,
} from "../../src/application/review-presentation.js";
import {
  GitHubPullRequestClient,
  GitHubPullRequestClientLive,
} from "../../src/github/pull-request-client.js";
import type { PullRequestRef } from "../../src/github/pull-request-client.js";

type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

const JsonValue: Schema.Schema<Json> = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record({ key: Schema.String, value: Schema.suspend(() => JsonValue) }),
);

// Only the fields read here are named; the rest of each record is carried
// through untouched so the benchmark's own steps still find everything.
const OtherFields = Schema.Record({ key: Schema.String, value: JsonValue });

const BenchmarkReview = Schema.Struct(
  {
    tool: Schema.String,
    pr_url: Schema.optional(Schema.NullOr(Schema.String)),
  },
  OtherFields,
);

type BenchmarkReview = typeof BenchmarkReview.Type;

const BenchmarkEntry = Schema.Struct(
  {
    source_repo: Schema.String,
    // One golden file per upstream repo; source_repo splits some in two.
    golden_source_file: Schema.String,
    reviews: Schema.Array(BenchmarkReview),
  },
  OtherFields,
);

type BenchmarkEntry = typeof BenchmarkEntry.Type;

const BenchmarkData = Schema.Record({
  key: Schema.String,
  value: BenchmarkEntry,
});

type BenchmarkData = typeof BenchmarkData.Type;

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

// The org Martian recreates every benchmark pull request in. Reviewing that
// copy gives Fletcher exactly the diff the other tools reviewed.
const BENCHMARK_ORG = "code-review-benchmark";

// Planning figures for --dry-run: what one review's output and thinking
// usually adds on top of the prompt. Real usage is printed after each review.
const PLANNED_OUTPUT_TOKENS = [4_000, 10_000] as const;

const usage = `Usage: pnpm --filter @not-quite-my-tempo/api bench:review \\
  --bench-dir <code-review-benchmark/offline> [options]

  --model <id>        Catalog model to review with (default gemini-3.8-flash)
  --tool <name>       Tool name in benchmark_data.json (default fletcher-<model>)
  --per-repo <n>      Only the first n pull requests of each of the 5 repos
  --only <url>        Only this pull request (its key in benchmark_data.json)
  --limit <n>         At most n pull requests in total
  --concurrency <n>   Reviews in flight at once (default 2)
  --timeout <s>       Seconds per model call (default: production's 420)
  --strategy <s>      single (one call, then verification; default) or
                      specialists (parallel focused passes, merged)
  --top <n>           Also record the first n findings of each review as
                      tool <tool>-top<n> (the merge orders by importance)
  --no-context        Review the diff alone, without repository context
  --force             Re-review pull requests this tool already reviewed
  --dry-run           Fetch and build every prompt, print the estimated
                      cost, and call no model

Env: VERTEX_API_KEY (Vertex AI API key; not needed for --dry-run),
     GITHUB_TOKEN (falls back to \`gh auth token\`).`;

const { values: args } = parseArgs({
  options: {
    "bench-dir": { type: "string" },
    model: { type: "string", default: "gemini-3.8-flash" },
    tool: { type: "string" },
    "per-repo": { type: "string" },
    only: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "2" },
    timeout: { type: "string" },
    strategy: { type: "string", default: "single" },
    top: { type: "string" },
    "no-context": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
};

const positiveInt = (name: string, value: string | undefined) => {
  if (value === undefined) {
    return Option.none<number>();
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0
    ? Option.some(parsed)
    : fail(`--${name} must be a positive integer, got "${value}".`);
};

if (args.help) {
  console.log(usage);
  process.exit(0);
}

const benchDir = args["bench-dir"] ?? fail("--bench-dir is required.");

const modelId = args.model;

const tool = args.tool ?? `fletcher-${modelId}`;

const strategy: ReviewStrategy =
  args.strategy === "single" || args.strategy === "specialists"
    ? args.strategy
    : fail(`--strategy must be single or specialists, got "${args.strategy}".`);

const perRepo = positiveInt("per-repo", args["per-repo"]);

const limit = positiveInt("limit", args.limit);

const concurrency = Option.getOrElse(
  positiveInt("concurrency", args.concurrency),
  () => 2,
);

const timeoutSeconds = positiveInt("timeout", args.timeout);

const top = positiveInt("top", args.top);

const topTool = Option.map(top, (n) => `${tool}-top${n}`);

const dryRun = args["dry-run"];

const catalogModel =
  findCatalogModel(modelId) ??
  fail(`"${modelId}" is not in packages/reviewer/src/catalog.ts.`);

if (catalogModel.vendor !== "google") {
  fail(`"${modelId}" is not a Gemini model; only Vertex AI is wired up.`);
}

const vertexApiKey = dryRun
  ? ""
  : (process.env["VERTEX_API_KEY"] ?? fail("VERTEX_API_KEY is not set."));

const githubToken =
  process.env["GITHUB_TOKEN"] ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

const dataPath = join(benchDir, "results", "benchmark_data.json");

const parsePullRequestUrl = (url: string) => {
  const match = PULL_REQUEST_URL.exec(url);

  return match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
    ? Option.none<PullRequestRef>()
    : Option.some<PullRequestRef>({
        owner: match[1],
        repo: match[2],
        pullRequestNumber: Number(match[3]),
      });
};

/** The benchmark's own copy of the pull request, else the golden URL. */
const sourcePullRequest = (goldenUrl: string, entry: BenchmarkEntry) => {
  const copies = entry.reviews.flatMap((review) =>
    Option.toArray(
      parsePullRequestUrl(review.pr_url ?? "").pipe(
        Option.filter((ref) => ref.owner === BENCHMARK_ORG),
      ),
    ),
  );

  return Option.orElse(Option.fromNullable(copies[0]), () =>
    parsePullRequestUrl(goldenUrl),
  );
};

const selectEntries = (data: BenchmarkData) => {
  const perRepoCounts = new Map<string, number>();
  const selected: [string, BenchmarkEntry][] = [];

  for (const [goldenUrl, entry] of Object.entries(data)) {
    if (args.only !== undefined && goldenUrl !== args.only) {
      continue;
    }

    const repo = entry.golden_source_file;
    const seen = perRepoCounts.get(repo) ?? 0;

    if (Option.isSome(perRepo) && seen >= perRepo.value) {
      continue;
    }

    perRepoCounts.set(repo, seen + 1);
    selected.push([goldenUrl, entry]);
  }

  return Option.match(limit, {
    onNone: () => selected,
    onSome: (max) => selected.slice(0, max),
  });
};

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

// Gemini bills thinking as output but reports it outside
// candidatesTokenCount, so output is total minus input where both exist.
const billedOutputTokens = (reviewUsage: ReviewUsage) =>
  reviewUsage.totalTokens !== null && reviewUsage.inputTokens !== null
    ? reviewUsage.totalTokens - reviewUsage.inputTokens
    : reviewUsage.outputTokens;

const estimatePromptTokens = (input: GeminiReviewInput) =>
  Math.ceil(
    (buildSystemPrompt(input.intensity, input.tone).length +
      buildReviewUserPrompt(input).length) /
      3.5,
  );

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

/**
 * The review as GitHub would show it: the summary as the review body, and
 * each finding on an added line as an inline comment (see
 * postReviewToGitHub).
 */
const reviewComments = (review: GeminiReview, diff: string) => {
  const findings = toFindings(review);
  const commentable = commentableLinesByFile(parseUnifiedDiff(diff));
  const createdAt = new Date().toISOString();

  const isAnchored = (finding: Finding) =>
    finding.line !== null &&
    (commentable.get(finding.filePath)?.has(finding.line) ?? false);

  const summary = {
    path: null,
    line: null,
    body: buildReviewSummaryBody(
      review,
      findings,
      findings.filter((finding) => !isAnchored(finding)),
      "standard",
    ),
    created_at: createdAt,
  };

  const inline = findings.filter(isAnchored).map((finding) => ({
    path: finding.filePath,
    line: finding.line,
    body: buildFindingCommentBody(finding),
    created_at: createdAt,
  }));

  return [summary, ...inline];
};

const buildReviewInput = (ref: PullRequestRef) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;

    const [details, rawDiff] = yield* Effect.all(
      [
        client.fetchDetails(githubToken, ref),
        client.fetchDiff(githubToken, ref),
      ],
      { concurrency: "unbounded" },
    );

    // The default config has no ignore globs; the built-in ones still apply.
    const diff = filterUnifiedDiff(rawDiff);

    const context = args["no-context"]
      ? null
      : yield* fetchRepositoryContext({
          installationToken: githubToken,
          ref,
          defaultBranch: details.baseRef,
          headSha: details.headSha,
          diff,
          guidelines: null,
        });

    const input: GeminiReviewInput = {
      repository: `${ref.owner}/${ref.repo}`,
      pullRequestNumber: ref.pullRequestNumber,
      title: details.title,
      body: details.body,
      diff,
      priorReview: null,
      context,
      intensity: "studio_band",
      tone: "standard",
    };

    return input;
  });

const reviewPullRequest = (ref: PullRequestRef, model: CatalogModel) =>
  Effect.gen(function* () {
    const input = yield* buildReviewInput(ref);
    const reviewer = yield* Reviewer;
    const result = yield* reviewer.review(input);
    const outputTokens = billedOutputTokens(result.usage);

    const costMicros = reviewCostUsdMicros(
      model,
      result.usage.inputTokens,
      outputTokens,
      result.usage.cachedInputTokens ?? null,
    );

    const recordFor = (
      name: string,
      review: GeminiReview,
    ): BenchmarkReview => ({
      tool: name,
      repo_name: `${ref.owner}/${ref.repo}`,
      pr_url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.pullRequestNumber}`,
      review_comments: reviewComments(review, input.diff),
      fletcher: {
        model: result.model,
        strategy,
        verdict: review.verdict,
        findings: review.findings.length,
        context: input.context !== null,
        input_tokens: result.usage.inputTokens,
        output_tokens: outputTokens,
        cached_input_tokens: result.usage.cachedInputTokens ?? null,
        cost_usd: costMicros / 1_000_000,
        verification: result.verification ?? null,
        fan_out: result.fanOut === undefined ? null : { ...result.fanOut },
      },
    });

    const record = recordFor(tool, result.review);

    // The same review cut to its first n findings; it cost the same calls.
    const variants = Option.match(Option.all([top, topTool]), {
      onNone: () => [],
      onSome: ([n, name]) => {
        const findings = result.review.findings.slice(0, n);

        return [
          recordFor(name, {
            ...result.review,
            findings,
            verdict: verdictForFindings(findings),
          }),
        ];
      },
    });

    const outcome = Match.value(result).pipe(
      Match.when(
        { fanOut: { merge: Match.string } },
        ({ fanOut }) =>
          `${fanOut.merge} ${fanOut.kept}/${fanOut.candidates} from ${fanOut.passes - fanOut.failedPasses}/${fanOut.passes} passes`,
      ),
      Match.when(
        { verification: { status: "verified" } },
        ({ verification }) =>
          `kept ${verification.kept}/${verification.candidates}`,
      ),
      Match.when(
        { verification: { status: "unverified" } },
        ({ verification }) => `unverified: ${verification.reason}`,
      ),
      Match.orElse(() => "no candidates"),
    );

    // The first comment is the summary; the rest are inline.
    return {
      records: [record, ...variants],
      costMicros,
      inlineCount: reviewComments(result.review, input.diff).length - 1,
      outcome,
    };
  });

const writeData = (data: BenchmarkData) =>
  Effect.sync(() =>
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`),
  );

const runReviews = (
  data: BenchmarkData,
  selected: readonly [string, BenchmarkEntry][],
) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(data);
    const spent = yield* Ref.make(0);
    const failed: string[] = [];

    yield* Effect.forEach(
      selected,
      ([goldenUrl, entry], index) =>
        Option.match(sourcePullRequest(goldenUrl, entry), {
          onNone: () => Effect.sync(() => failed.push(goldenUrl)),
          onSome: (ref) =>
            reviewPullRequest(ref, catalogModel).pipe(
              Effect.flatMap(({ records, costMicros, inlineCount, outcome }) =>
                Ref.updateAndGet(state, (current) => {
                  const existing = current[goldenUrl] ?? entry;

                  return {
                    ...current,
                    [goldenUrl]: {
                      ...existing,
                      reviews: [
                        ...existing.reviews.filter(
                          (review) =>
                            !records.some(
                              (record) => record.tool === review.tool,
                            ),
                        ),
                        ...records,
                      ],
                    },
                  };
                }).pipe(
                  Effect.flatMap(writeData),
                  Effect.zipRight(
                    Ref.updateAndGet(spent, (n) => n + costMicros),
                  ),
                  Effect.tap((total) =>
                    Effect.sync(() =>
                      console.log(
                        `[${index + 1}/${selected.length}] ${goldenUrl}: ${inlineCount} inline (${outcome}), ${usd(costMicros)} (total ${usd(total)})`,
                      ),
                    ),
                  ),
                ),
              ),
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  failed.push(goldenUrl);
                  console.error(
                    `[${index + 1}/${selected.length}] ${goldenUrl}: failed (${error._tag})`,
                  );
                }),
              ),
            ),
        }),
      { concurrency, discard: true },
    );

    const total = yield* Ref.get(spent);

    console.log(
      `\nReviewed ${selected.length - failed.length}/${selected.length} as "${tool}", ${usd(total)} spent.`,
    );

    if (failed.length > 0) {
      console.log(
        `Failed (rerun to retry; finished reviews are kept):\n${failed.map((url) => `  ${url}`).join("\n")}`,
      );
    }
  });

const estimateCost = (selected: readonly [string, BenchmarkEntry][]) =>
  Effect.gen(function* () {
    const promptTokens = yield* Effect.forEach(
      selected,
      ([goldenUrl, entry]) =>
        Option.match(sourcePullRequest(goldenUrl, entry), {
          onNone: () => Effect.succeed(0),
          onSome: (ref) =>
            buildReviewInput(ref).pipe(
              Effect.map(estimatePromptTokens),
              Effect.tap((tokens) =>
                Effect.sync(() =>
                  console.log(`${goldenUrl}: ~${tokens} prompt tokens`),
                ),
              ),
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.error(`${goldenUrl}: failed (${error._tag})`);

                  return 0;
                }),
              ),
            ),
        }),
      { concurrency },
    );

    const input = promptTokens.reduce((sum, tokens) => sum + tokens, 0);

    const [low, high] = PLANNED_OUTPUT_TOKENS.map((perReview) =>
      reviewCostUsdMicros(catalogModel, input, perReview * promptTokens.length),
    );

    console.log(
      `\n${promptTokens.length} reviews on ${modelId}: ~${input} prompt tokens, ` +
        `${usd(reviewCostUsdMicros(catalogModel, input, 0))} of input.\n` +
        `With ${PLANNED_OUTPUT_TOKENS[0]}–${PLANNED_OUTPUT_TOKENS[1]} output and thinking tokens per review: ` +
        `${usd(low ?? 0)}–${usd(high ?? 0)} in total.`,
    );
  });

const program = Effect.gen(function* () {
  const data = yield* Schema.decodeUnknown(Schema.parseJson(BenchmarkData))(
    readFileSync(dataPath, "utf8"),
  );

  const selected = selectEntries(data).filter(
    ([, entry]) =>
      args.force || !entry.reviews.some((review) => review.tool === tool),
  );

  console.log(
    `${selected.length} pull request(s) to review as "${tool}" with ${modelId}` +
      `${args["no-context"] ? ", diff only" : ""}${dryRun ? " (dry run)" : ""}.\n`,
  );

  if (dryRun) {
    return yield* estimateCost(selected);
  }

  return yield* runReviews(data, selected);
});

// The same project lookup production does, so models served only from
// Vertex AI's global location (Gemini 4 Argon) work here too.
const ReviewerFromKey = Layer.unwrapEffect(
  (dryRun
    ? Effect.succeed<ResolvedReviewKey>({
        apiKey: vertexApiKey,
        provider: "vertex_express",
        model: modelId,
      })
    : withVertexProject({
        apiKey: vertexApiKey,
        provider: "vertex_express",
        model: modelId,
      })
  ).pipe(
    Effect.map((key) =>
      ReviewerLive(
        Option.match(timeoutSeconds, {
          onNone: (): ReviewerConfig => ({ ...key, strategy }),
          onSome: (seconds): ReviewerConfig => ({
            ...key,
            strategy,
            timeoutMillis: seconds * 1_000,
          }),
        }),
      ),
    ),
  ),
);

const MainLive = Layer.merge(GitHubPullRequestClientLive({}), ReviewerFromKey);

await Effect.runPromise(program.pipe(Effect.provide(MainLive)));

/**
 * Fletcher as a ReviewBench agent (https://review-bench.ai). ReviewBench
 * starts one container per pull request with the repository checked out at
 * its head, the diff and metadata mounted, and reads the findings file this
 * writes. See ReviewBench's AGENT_CONTRACT.md for the variables used here.
 *
 * Settings come from the registered configuration (RB_CONFIG_*):
 *   model     catalog model id (default gemini-3.8-flash)
 *   provider  gemini_api (AI Studio key) or vertex_express (default gemini_api)
 *   strategy  single or specialists (default single)
 *   context   related (callers and tests from the checkout) or basic
 * The model key arrives as GEMINI_API_KEY. FLETCHER_DRY_RUN=1 builds the
 * prompt, prints its size, and writes no findings, for checking context.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { Effect, Layer, Option, Schema } from "effect";
import { parseUnifiedDiff, filterUnifiedDiff } from "@not-quite-my-tempo/core";
import {
  buildReviewUserPrompt,
  Reviewer,
  ReviewerLive,
} from "@not-quite-my-tempo/reviewer";
import type {
  GeminiFinding,
  GeminiReviewInput,
  ReviewerConfig,
  ReviewProvider,
  ReviewStrategy,
} from "@not-quite-my-tempo/reviewer";

import { findRelatedCode } from "../../src/application/related-code.js";
import { buildRepositoryContext } from "../../src/application/repository-context.js";
import { withVertexProject } from "../../src/application/review-keys.js";
import { checkoutSearch, checkoutSource } from "./checkout.js";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const env = (name: string) => process.env[name] ?? fail(`${name} is not set.`);

const config = (key: string, fallback: string) =>
  process.env[`RB_CONFIG_${key}`] ?? fallback;

const oneOf = <A extends string>(
  name: string,
  value: string,
  allowed: readonly A[],
): A =>
  allowed.find((candidate) => candidate === value) ??
  fail(`${name} must be one of ${allowed.join(", ")}, got "${value}".`);

const repo = process.env["RB_REPO_DIR"] ?? "/work/repo";

const head = env("RB_HEAD");

const base = env("RB_BASE");

const agent = env("RB_AGENT");

const pullRequestNumber = Number(env("RB_PR_NUMBER"));

const dryRun = process.env["FLETCHER_DRY_RUN"] === "1";

const model = config("MODEL", "gemini-3.8-flash");

const provider = oneOf<ReviewProvider>(
  "provider",
  config("PROVIDER", "gemini_api"),
  ["gemini_api", "vertex_express"],
);

const strategy = oneOf<ReviewStrategy>(
  "strategy",
  config("STRATEGY", "single"),
  ["single", "specialists"],
);

const contextMode = oneOf("context", config("CONTEXT", "related"), [
  "related",
  "basic",
] as const);

// ReviewBench names any configured label whose value never appears here.
console.log(
  `model=${model} provider=${provider} strategy=${strategy} context=${contextMode}`,
);

const PullRequestJson = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
});

const pr = Schema.decodeUnknownSync(Schema.parseJson(PullRequestJson))(
  readFileSync(env("RB_PR_JSON"), "utf8"),
);

const diff = filterUnifiedDiff(readFileSync(env("RB_DIFF"), "utf8"));

// A finding needs a line: file-level ones go on the file's first added line.
const firstAddedLine = new Map(
  parseUnifiedDiff(diff).flatMap((file) => {
    const line = file.hunks
      .flatMap((hunk) => hunk.lines)
      .find((candidate) => candidate.kind === "added")?.newLine;

    return line == null ? [] : [[file.path, line] as const];
  }),
);

const toOutput = (finding: GeminiFinding) => {
  const line = finding.line ?? firstAddedLine.get(finding.filePath) ?? 1;

  return {
    file: finding.filePath,
    start_line: line,
    end_line: line,
    message: `${finding.title}: ${finding.message}`,
    producer: agent,
  };
};

const writeFindings = (findings: readonly GeminiFinding[]) =>
  Effect.sync(() =>
    writeFileSync(
      env("RB_OUT"),
      `${JSON.stringify(
        {
          pr: {
            repo: `https://github.com/${env("RB_NWO")}`,
            pr_number: pullRequestNumber,
            base,
            head,
          },
          agent,
          findings: findings.map(toOutput),
        },
        null,
        2,
      )}\n`,
    ),
  );

const program = Effect.gen(function* () {
  // ReviewBench has no default branch: guidelines come from the base, which
  // the pull request can't rewrite either.
  const context = yield* buildRepositoryContext(checkoutSource(repo), {
    defaultBranch: base,
    headSha: head,
    diff,
    guidelines: null,
  });

  if (context === null) {
    console.error("repository context unavailable: reviewing the diff alone");
  }

  const related =
    contextMode === "related" && context !== null
      ? yield* findRelatedCode(
          checkoutSearch(repo),
          diff,
          context.files.map((file) => file.path),
        )
      : [];

  const input: GeminiReviewInput = {
    repository: env("RB_NWO"),
    pullRequestNumber,
    title: pr.title ?? "",
    body: pr.body ?? null,
    diff,
    priorReview: null,
    context: context === null ? null : { ...context, related },
    intensity: "studio_band",
    tone: "standard",
  };

  console.log(
    `prompt ${buildReviewUserPrompt(input).length} chars, ` +
      `${context?.files.length ?? 0} files, ${related.length} related snippets`,
  );

  if (dryRun) {
    for (const snippet of related) {
      console.log(
        `  related ${snippet.path}:${snippet.startLine}-${snippet.endLine} (${snippet.reason})`,
      );
    }

    return yield* writeFindings([]);
  }

  const reviewer = yield* Reviewer;

  const result = yield* reviewer.review(input);

  console.log(
    `findings=${result.review.findings.length} tokens=${result.usage.totalTokens ?? "unknown"}`,
  );

  return yield* writeFindings(result.review.findings);
});

const ReviewerFromKey = Layer.unwrapEffect(
  withVertexProject({
    apiKey: dryRun ? "" : env("GEMINI_API_KEY"),
    provider,
    model,
  }).pipe(
    Effect.map((key) => {
      const baseUrl = Option.fromNullable(
        process.env["RB_MODEL_BASE_URL"],
      ).pipe(Option.map((url) => new URL(url).origin));

      const reviewer: ReviewerConfig = {
        ...key,
        strategy,
        // Free-tier keys answer 429 often; a pull request may take 30
        // minutes, so wait rate limits out rather than fail the run.
        maxRetries: 8,
        retryBaseMillis: 5_000,
        ...Option.match(baseUrl, {
          onNone: () => ({}),
          onSome: (origin) => ({ baseUrl: origin }),
        }),
      };

      return ReviewerLive(reviewer);
    }),
  ),
);

await Effect.runPromise(
  program.pipe(
    Effect.provide(ReviewerFromKey),
    Effect.tapError((error) =>
      Effect.sync(() => console.error(`review failed: ${error._tag}`)),
    ),
    Effect.catchAll(() => Effect.sync(() => process.exit(1))),
  ),
);

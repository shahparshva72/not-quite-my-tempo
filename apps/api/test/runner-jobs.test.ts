import { env } from "cloudflare:workers";
import { Effect, Either, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, RunnerJobRepository } from "@not-quite-my-tempo/db";
import type { GeminiReview } from "@not-quite-my-tempo/reviewer";

import app from "../src/index";
import {
  claimRunnerJob,
  expireRunnerJob,
  issueRunnerJob,
  reportRunnerJob,
  repositoryReviewRunner,
  RUNNER_MODELS,
  RUNNER_WORKFLOW_FILE,
  runnerModelFor,
  RunnerResultSink,
  runnerResultOf,
} from "../src/application/runner-jobs";
import type { RunnerResult } from "../src/application/runner-jobs";
import { persistRunnerReviewFindings } from "../src/application/review-workflow";
import {
  GITHUB_ACTIONS_ISSUER,
  GitHubActionsOidc,
  GitHubActionsOidcLive,
} from "../src/github/actions-oidc";
import type { ActionsOidcClaims } from "../src/github/actions-oidc";
import type { ReviewRequest } from "../src/github/review-request";
import { runnerWorkflowYaml } from "../src/dashboard/runner-workflow";
import { resetAndSeedRepository } from "./database";

const HEAD_SHA = "a".repeat(40);

const request: ReviewRequest = {
  installationId: 1001,
  installationAccountId: 2001,
  installationAccountType: "Organization",
  githubRepositoryId: 3001,
  owner: "not-my-tempo",
  repo: "app",
  defaultBranch: "main",
  pullRequestNumber: 7,
  headSha: HEAD_SHA,
  trigger: "opened",
};

const claims = (
  overrides: Partial<ActionsOidcClaims> = {},
): ActionsOidcClaims => ({
  iss: GITHUB_ACTIONS_ISSUER,
  aud: ["fletcher"],
  exp: Math.floor(Date.now() / 1000) + 300,
  repository: "not-my-tempo/app",
  repository_id: "3001",
  repository_owner_id: "2001",
  event_name: "pull_request",
  ref: "refs/pull/7/merge",
  sha: "b".repeat(40),
  run_id: "555",
  run_attempt: "1",
  job_workflow_ref: `not-my-tempo/app/.github/workflows/${RUNNER_WORKFLOW_FILE}@refs/pull/7/merge`,
  ...overrides,
});

const review: GeminiReview = {
  verdict: "almost",
  summary: "Not quite my tempo.",
  findings: [
    {
      filePath: "src/tempo.ts",
      line: 14,
      severity: "warning",
      category: "correctness",
      confidence: 0.8,
      title: "Off-by-one",
      message: "Guard the subdivision.",
    },
  ],
};

const seedRun = () =>
  env.DB.prepare(
    `INSERT INTO review_runs (id, repository_id, pull_request_number, head_sha, status, trigger)
     VALUES (1, 1, 7, ?, 'running', 'opened')`,
  )
    .bind(HEAD_SHA)
    .run();

const delivered: { instanceId: string; result: RunnerResult }[] = [];

const SinkTest = Layer.succeed(
  RunnerResultSink,
  RunnerResultSink.of({
    deliver: (instanceId, result) =>
      Effect.sync(() => {
        delivered.push({ instanceId, result });
      }),
  }),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, RunnerJobRepository | RunnerResultSink | never>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(makeLiveLayer(env.DB)),
      Effect.provide(SinkTest),
      Effect.either,
    ),
  );

const issue = () =>
  Effect.runPromise(
    issueRunnerJob(1, "review-run-1", request).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
    ),
  );

describe("runner jobs", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await seedRun();
    delivered.length = 0;
  });

  it("reviews in Fletcher until the repository picks its runner", async () => {
    const before = await Effect.runPromise(
      repositoryReviewRunner(1).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    await env.DB.prepare(
      "UPDATE repositories SET review_runner = 'claude_actions' WHERE id = 1",
    ).run();

    const after = await Effect.runPromise(
      repositoryReviewRunner(1).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect([before, after]).toEqual(["fletcher", "claude_actions"]);
  });

  it("issues one job per run, even when the step is retried", async () => {
    const first = await issue();
    const second = await issue();

    expect(second.jobId).toBe(first.jobId);
    expect(first.jobId).toMatch(/^rj_[0-9a-f]{32}$/);
  });

  it("lets one GitHub Actions run claim the job, and only that run", async () => {
    await issue();

    const claimed = await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    expect(Either.isRight(claimed)).toBe(true);

    if (Either.isRight(claimed)) {
      expect(claimed.right.request).toEqual(request);
      expect(claimed.right.job.status).toBe("claimed");
    }

    const again = await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    expect(Either.isRight(again)).toBe(true);

    const other = await run(
      claimRunnerJob(claims({ run_id: "556" }), {
        pullRequestNumber: 7,
        headSha: HEAD_SHA,
      }),
    );

    expect(Either.isLeft(other) && other.left._tag).toBe(
      "RunnerJobUnavailableError",
    );
  });

  it("says not ready when no job waits for that commit yet", async () => {
    const result = await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    expect(Either.isLeft(result) && result.left._tag).toBe(
      "RunnerJobNotReadyError",
    );
  });

  it.each([
    ["pull_request_target runs", { event_name: "pull_request_target" }],
    ["runs for another pull request", { ref: "refs/pull/8/merge" }],
    [
      "other workflow files",
      {
        job_workflow_ref:
          "not-my-tempo/app/.github/workflows/ci.yml@refs/pull/7/merge",
      },
    ],
    [
      "workflows from another repository",
      {
        job_workflow_ref: `evil/app/.github/workflows/${RUNNER_WORKFLOW_FILE}@refs/heads/main`,
      },
    ],
  ] as const)("rejects %s", async (_label, overrides) => {
    await issue();

    const result = await run(
      claimRunnerJob(claims(overrides), {
        pullRequestNumber: 7,
        headSha: HEAD_SHA,
      }),
    );

    expect(Either.isLeft(result) && result.left._tag).toBe(
      "RunnerClaimsRejectedError",
    );
  });

  it("never hands a job to another repository's runner", async () => {
    await issue();

    const result = await run(
      claimRunnerJob(claims({ repository_id: "9999" }), {
        pullRequestNumber: 7,
        headSha: HEAD_SHA,
      }),
    );

    expect(Either.isLeft(result) && result.left._tag).toBe(
      "RunnerJobNotReadyError",
    );
  });

  it("resumes the Workflow with the claimant's review, once", async () => {
    const { jobId } = await issue();

    await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    const report = {
      outcome: "success",
      structuredOutput: review,
      model: "claude-sonnet-5-5",
      inputTokens: 1200,
      outputTokens: 300,
    } as const;

    const first = await run(reportRunnerJob(claims(), jobId, report));

    expect(Either.isRight(first) && first.right).toEqual({
      status: "completed",
    });
    expect(delivered).toEqual([
      {
        instanceId: "review-run-1",
        result: {
          status: "completed",
          review,
          model: "claude-sonnet-5-5",
          usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
        },
      },
    ]);

    const second = await run(reportRunnerJob(claims(), jobId, report));

    expect(Either.isLeft(second) && second.left._tag).toBe(
      "RunnerJobUnavailableError",
    );
    expect(delivered).toHaveLength(1);
  });

  it("refuses reports from runs that didn't claim the job", async () => {
    const { jobId } = await issue();

    await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    const otherRun = await run(
      reportRunnerJob(claims({ run_attempt: "2" }), jobId, {
        outcome: "success",
        structuredOutput: review,
        inputTokens: null,
        outputTokens: null,
      }),
    );

    const otherRepository = await run(
      reportRunnerJob(claims({ repository_id: "9999" }), jobId, {
        outcome: "success",
        structuredOutput: review,
        inputTokens: null,
        outputTokens: null,
      }),
    );

    expect(Either.isLeft(otherRun) && otherRun.left._tag).toBe(
      "RunnerJobUnavailableError",
    );
    expect(Either.isLeft(otherRepository) && otherRepository.left._tag).toBe(
      "RunnerJobNotFoundError",
    );
    expect(delivered).toHaveLength(0);
  });

  it("can't be claimed once the Workflow stops waiting", async () => {
    await issue();

    await Effect.runPromise(
      expireRunnerJob(1).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    const result = await run(
      claimRunnerJob(claims(), { pullRequestNumber: 7, headSha: HEAD_SHA }),
    );

    expect(Either.isLeft(result) && result.left._tag).toBe(
      "RunnerJobNotReadyError",
    );
  });

  it("records a runner review at no cost to Fletcher", async () => {
    await Effect.runPromise(
      persistRunnerReviewFindings(1, {
        review,
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    const row = await env.DB.prepare(
      "SELECT provider, cost_usd_micros, verdict FROM review_runs WHERE id = 1",
    ).first();

    expect(row).toEqual({
      provider: "claude_actions",
      cost_usd_micros: 0,
      verdict: "almost",
    });
  });
});

describe("runnerModelFor", () => {
  it("offers every Claude model, Opus included", () => {
    expect(RUNNER_MODELS).toEqual(
      expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5"]),
    );
  });

  it("uses the repository's pick, or the default for none or a retired one", () => {
    expect(runnerModelFor({ runnerModel: "claude-opus-5-5" })).toBe(
      "claude-opus-5-5",
    );
    expect(runnerModelFor({ runnerModel: null })).toBe("claude-sonnet-5-5");
    expect(runnerModelFor({ runnerModel: "claude-opus-4" })).toBe(
      "claude-sonnet-5-5",
    );
  });
});

describe("runnerResultOf", () => {
  const base = { inputTokens: null, outputTokens: null } as const;

  it("fails the run when the output isn't a review", () => {
    expect(
      runnerResultOf({
        ...base,
        outcome: "success",
        structuredOutput: { verdict: "maybe" },
      }),
    ).toMatchObject({ status: "failed", code: "runner_output_invalid" });
  });

  it("keeps the runner's reason for a failure", () => {
    expect(
      runnerResultOf({ ...base, outcome: "failure", message: "401 from API" }),
    ).toEqual({
      status: "failed",
      code: "runner_failed",
      message: "401 from API",
    });
  });

  it("marks cancelled runs as cancelled", () => {
    expect(runnerResultOf({ ...base, outcome: "cancelled" })).toMatchObject({
      code: "runner_cancelled",
    });
  });
});

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

// A JWT header or claims set, as the tests write them.
type JwtSegment = Readonly<
  Record<string, string | number | readonly string[] | undefined>
>;

const encodeJson = (value: JwtSegment) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const generateKey = async () =>
  // SAFETY: an RSASSA key generation always yields a key pair.
  (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

const sign = async (
  key: CryptoKey,
  payload: JwtSegment,
  header: JwtSegment = { alg: "RS256", kid: "key-1", typ: "JWT" },
) => {
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );

  return `${input}.${base64Url(new Uint8Array(signature))}`;
};

describe("GitHub Actions OIDC", async () => {
  const pair = await generateKey();
  const stranger = await generateKey();
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  let jwksUrlCount = 0;

  // A fresh URL per check, so the module's key cache can't leak between them.
  const verify = (token: string) => {
    jwksUrlCount += 1;

    return Effect.runPromise(
      GitHubActionsOidc.pipe(
        Effect.flatMap((oidc) => oidc.verify(token)),
        Effect.provide(
          GitHubActionsOidcLive({
            audience: "fletcher",
            jwksUrl: `https://jwks.test/${jwksUrlCount}`,
            fetchImpl: () =>
              Promise.resolve(
                Response.json({ keys: [{ ...publicJwk, kid: "key-1" }] }),
              ),
          }),
        ),
        Effect.either,
      ),
    );
  };

  const reasonOf = async (token: string) => {
    const result = await verify(token);

    return Either.isLeft(result) ? result.left.reason : "verified";
  };

  it("accepts a token GitHub signed for Fletcher", async () => {
    const result = await verify(await sign(pair.privateKey, claims()));

    expect(Either.isRight(result) && result.right.repository_id).toBe("3001");
  });

  it("accepts a single audience string", async () => {
    const token = await sign(pair.privateKey, { ...claims(), aud: "fletcher" });

    expect(await reasonOf(token)).toBe("verified");
  });

  it.each([
    ["another audience", { aud: ["sts.amazonaws.com"] }, "wrong_audience"],
    ["another issuer", { iss: "https://evil.test" }, "wrong_issuer"],
    ["an expired token", { exp: 1_000 }, "expired"],
    [
      "a token not valid yet",
      { nbf: Math.floor(Date.now() / 1000) + 3_600 },
      "not_yet_valid",
    ],
  ] as const)("rejects %s", async (_label, overrides, reason) => {
    const token = await sign(pair.privateKey, { ...claims(), ...overrides });

    expect(await reasonOf(token)).toBe(reason);
  });

  it("rejects a token signed by another key", async () => {
    expect(await reasonOf(await sign(stranger.privateKey, claims()))).toBe(
      "bad_signature",
    );
  });

  it("rejects a key id GitHub doesn't publish", async () => {
    const token = await sign(pair.privateKey, claims(), {
      alg: "RS256",
      kid: "key-2",
    });

    expect(await reasonOf(token)).toBe("unknown_key");
  });

  it("rejects unsigned tokens", async () => {
    const token = `${encodeJson({ alg: "none", kid: "key-1" })}.${encodeJson(claims())}.`;

    expect(await reasonOf(token)).toBe("unsupported_algorithm");
  });

  it("rejects garbage", async () => {
    expect(await reasonOf("not-a-jwt")).toBe("malformed");
  });
});

describe("runner routes", () => {
  const post = (path: string, init: RequestInit = {}) =>
    app.request(`https://example.com${path}`, { method: "POST", ...init }, env);

  it("require the job's OIDC token", async () => {
    const response = await post("/runner/v1/claim", {
      body: JSON.stringify({ pullRequestNumber: 7, headSha: HEAD_SHA }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "missing_token" },
    });
  });

  it("reject tokens that don't verify", async () => {
    const response = await post("/runner/v1/jobs/rj_x/result", {
      headers: { authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ outcome: "cancelled" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_token" },
    });
  });
});

describe("runner workflow template", () => {
  const yaml = runnerWorkflowYaml("https://fletcher.test");

  it("runs only on pull_request, with the secret in the review step alone", () => {
    expect(yaml).toContain("  pull_request: # never pull_request_target");
    expect(yaml).not.toMatch(/^\s+pull_request_target:/m);
    expect(yaml.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/g)).toHaveLength(1);
  });

  it("keeps the pull request's own Claude settings and hooks out", () => {
    expect(yaml).toContain("--setting-sources user");
    expect(yaml).toContain("--strict-mcp-config");
  });

  it("reports the model Claude Code ran, not just the one asked for", () => {
    expect(yaml).toContain("(.modelUsage // {} | keys | first) // $model");
  });

  it("leaves the check green when Fletcher can't be reached", () => {
    expect(yaml).toContain('-d "$body") || status=unreachable');
  });

  it("talks to the Fletcher it was shown on", () => {
    expect(yaml).toContain("FLETCHER_URL: https://fletcher.test");
    expect(yaml).toContain(`workflows/${RUNNER_WORKFLOW_FILE}`);
  });
});

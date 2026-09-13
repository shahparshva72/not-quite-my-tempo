import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  listAccessibleRepositories,
  listRepositoryRuns,
  listRunFindings,
  usageSummary,
} from "../src/application/read-api";
import { persistReviewFindings } from "../src/application/review-workflow";
import type { GeminiReviewResult } from "@not-quite-my-tempo/gemini";
import { resetAndSeedRepository } from "./database";

const dbLayer = () => makeLiveLayer(env.DB);

const reviewResult: GeminiReviewResult = {
  review: {
    verdict: "almost",
    summary: "Not quite my tempo.",
    findings: [
      {
        filePath: "src/tempo.ts",
        line: 14,
        severity: "warning",
        category: null,
        confidence: 0.8,
        title: "Off-by-one",
        message: "Guard it.",
      },
    ],
  },
  model: "gemini-3.8-flash",
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
};

const seedRun = (headSha: string) =>
  Effect.gen(function* () {
    const reviewRuns = yield* ReviewRunRepository;

    const run = yield* reviewRuns.create({
      repositoryId: 1,
      pullRequestNumber: 42,
      headSha,
      trigger: "opened",
    });

    yield* persistReviewFindings(run.id, reviewResult);

    return run;
  });

describe("read API", () => {
  beforeEach(resetAndSeedRepository);

  it("lists repositories only for the session's installations", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accessible = yield* listAccessibleRepositories([1001]);
        const foreign = yield* listAccessibleRepositories([9999]);
        const none = yield* listAccessibleRepositories([]);

        return { accessible, foreign, none };
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(result.accessible.map((repo) => repo.fullName)).toEqual([
      "not-my-tempo/app",
    ]);
    expect(result.foreign).toEqual([]);
    expect(result.none).toEqual([]);
  });

  it("lists runs for an accessible repository and 404s otherwise", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedRun("read123");

        const allowed = yield* listRepositoryRuns([1001], 1);
        const denied = yield* listRepositoryRuns([9999], 1).pipe(Effect.flip);

        const missing = yield* listRepositoryRuns([1001], 404).pipe(
          Effect.flip,
        );

        return { allowed, denied, missing };
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(result.allowed.runs).toHaveLength(1);
    expect(result.allowed.runs[0]).toMatchObject({ headSha: "read123" });
    expect(result.denied._tag).toBe("ResourceNotFoundError");
    expect(result.missing._tag).toBe("ResourceNotFoundError");
  });

  it("returns findings for an accessible run and 404s otherwise", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* seedRun("find123");

        const allowed = yield* listRunFindings([1001], run.id);

        const denied = yield* listRunFindings([9999], run.id).pipe(Effect.flip);

        return { allowed, denied };
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(result.allowed.findings).toHaveLength(1);
    expect(result.allowed.findings[0]).toMatchObject({
      filePath: "src/tempo.ts",
      severity: "warning",
    });
    expect(result.denied._tag).toBe("ResourceNotFoundError");
  });

  it("aggregates token usage per repository", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedRun("usage1");
        yield* seedRun("usage2");

        return yield* usageSummary([1001]);
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(result).toEqual([
      {
        repositoryId: 1,
        fullName: "not-my-tempo/app",
        runCount: 2,
        inputTokens: 2000,
        outputTokens: 400,
        totalTokens: 2400,
      },
    ]);
  });
});

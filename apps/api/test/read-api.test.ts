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
import type { ReviewResult } from "@not-quite-my-tempo/reviewer";
import { testAccess } from "./authentication";
import { resetAndSeedRepository } from "./database";

const dbLayer = () => makeLiveLayer(env.DB);

const asAccess = (repositoryIds: readonly number[]) =>
  Effect.promise(() => testAccess(repositoryIds));

const reviewResult: ReviewResult = {
  provider: "gemini_api",
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

  it("lists only the repositories authorized for the session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accessible = yield* listAccessibleRepositories(
          yield* asAccess([3001]),
        );

        const foreign = yield* listAccessibleRepositories(
          yield* asAccess([9999]),
        );

        const none = yield* listAccessibleRepositories(yield* asAccess([]));

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

        const allowed = yield* listRepositoryRuns(yield* asAccess([3001]), 1);

        const denied = yield* listRepositoryRuns(
          yield* asAccess([9999]),
          1,
        ).pipe(Effect.flip);

        const missing = yield* listRepositoryRuns(
          yield* asAccess([3001]),
          404,
        ).pipe(Effect.flip);

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

        const allowed = yield* listRunFindings(yield* asAccess([3001]), run.id);

        const denied = yield* listRunFindings(
          yield* asAccess([9999]),
          run.id,
        ).pipe(Effect.flip);

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

        return yield* usageSummary(yield* asAccess([3001]));
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

  it("does not expose sibling repositories or usage from the same installation", async () => {
    await env.DB.prepare(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
       VALUES (2, 1, 3002, 'not-my-tempo', 'private', 'not-my-tempo/private', 'main')`,
    ).run();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* seedRun("private-access");

        const visible = yield* listAccessibleRepositories(
          yield* asAccess([3002]),
        );

        const runs = yield* listRepositoryRuns(yield* asAccess([3002]), 1).pipe(
          Effect.flip,
        );

        const findings = yield* listRunFindings(
          yield* asAccess([3002]),
          run.id,
        ).pipe(Effect.flip);

        const usage = yield* usageSummary(yield* asAccess([3002]));

        return { visible, runs, findings, usage };
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(result.visible.map((repo) => repo.id)).toEqual([2]);
    expect(result.runs._tag).toBe("ResourceNotFoundError");
    expect(result.findings._tag).toBe("ResourceNotFoundError");
    expect(result.usage).toEqual([
      {
        repositoryId: 2,
        fullName: "not-my-tempo/private",
        runCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    ]);
  });

  it("handles repository grants beyond one GitHub page without exceeding D1 bind limits", async () => {
    const rows = Array.from({ length: 105 }, (_, index) => {
      const id = index + 2;

      return env.DB.prepare(
        `INSERT INTO repositories
          (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
         VALUES (?, 1, ?, 'not-my-tempo', ?, ?, 'main')`,
      ).bind(id, 3000 + id, `repo-${id}`, `not-my-tempo/repo-${id}`);
    });

    await env.DB.batch(rows);
    const grants = Array.from({ length: 106 }, (_, index) => 3001 + index);

    const usage = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedRun("large-grant-list");

        return yield* usageSummary(yield* asAccess(grants));
      }).pipe(Effect.provide(dbLayer())),
    );

    expect(usage).toHaveLength(106);
    expect(usage.find((row) => row.repositoryId === 1)?.totalTokens).toBe(1200);
  });
});

import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  markReviewCompleted,
  markReviewRunning,
  performFakeReview,
} from "../src/application/review-workflow";
import { resetAndSeedRepository } from "./database";

describe("review workflow program", () => {
  beforeEach(resetAndSeedRepository);

  it("moves a review run through running and completed around the fake review", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const reviewRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 42,
          headSha: "workflow123",
          trigger: "opened",
        });

        const running = yield* markReviewRunning(reviewRun.id);
        const review = yield* performFakeReview();
        const completed = yield* markReviewCompleted(reviewRun.id);

        return { running, review, completed };
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(result.running).toMatchObject({ status: "running" });
    expect(result.review).toEqual({
      summary: "Fake review completed",
      findings: [],
    });
    expect(result.completed).toMatchObject({ status: "completed" });
  });
});

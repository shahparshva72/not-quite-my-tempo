import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";

import {
  handleReviewRequest,
  ReviewWorkflow,
} from "../src/application/review-requests";
import type { ReviewRequest } from "../src/github/review-request";
import { resetAndSeedRepository } from "./database";

const request: ReviewRequest = {
  installationId: 1001,
  installationAccountId: 2001,
  installationAccountType: "Organization",
  githubRepositoryId: 3001,
  owner: "not-my-tempo",
  repo: "app",
  defaultBranch: "main",
  pullRequestNumber: 42,
  headSha: "cap123",
  trigger: "opened",
};

const stubWorkflowLayer = Layer.succeed(
  ReviewWorkflow,
  ReviewWorkflow.of({ start: () => Effect.succeed("wf-test") }),
);

describe("daily review run cap", () => {
  beforeEach(resetAndSeedRepository);

  it("queues a review while the installation is under the cap", async () => {
    const result = await Effect.runPromise(
      handleReviewRequest(request, 5).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(stubWorkflowLayer),
      ),
    );

    expect(result).toMatchObject({ status: "queued" });
  });

  it("acknowledges without a review once the cap is reached", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 41,
          headSha: "earlier123",
          trigger: "opened",
        });

        return yield* handleReviewRequest(request, 1);
      }).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
        Effect.provide(stubWorkflowLayer),
      ),
    );

    expect(result).toEqual({ status: "rate_limited" });
  });
});

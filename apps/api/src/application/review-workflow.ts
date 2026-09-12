import { Data, Effect, Schema } from "effect";
import { ReviewRunRepository } from "@not-quite-my-tempo/db";
import type { DatabaseError, ReviewRun } from "@not-quite-my-tempo/db";
import type { Option } from "effect";

export const FakeReviewResult = Schema.Struct({
  summary: Schema.Literal("Fake review completed"),
  findings: Schema.Tuple(),
});

export type FakeReviewResult = typeof FakeReviewResult.Type;

export class ReviewRunNotFoundError extends Data.TaggedError(
  "ReviewRunNotFoundError",
)<{
  readonly reviewRunId: number;
}> {}

const requireReviewRun = (
  reviewRunId: number,
  reviewRun: Effect.Effect<
    Option.Option<ReviewRun>,
    DatabaseError,
    ReviewRunRepository
  >,
) =>
  reviewRun.pipe(
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => new ReviewRunNotFoundError({ reviewRunId }),
    ),
  );

export const markReviewRunning = (reviewRunId: number) =>
  requireReviewRun(reviewRunId, ReviewRunRepository.markRunning(reviewRunId));

export const performFakeReview = (): Effect.Effect<FakeReviewResult> =>
  Effect.succeed({ summary: "Fake review completed", findings: [] });

export const markReviewCompleted = (reviewRunId: number) =>
  requireReviewRun(reviewRunId, ReviewRunRepository.markCompleted(reviewRunId));

export const markReviewFailed = (
  reviewRunId: number,
  errorCode: string,
  errorMessage: string,
) =>
  requireReviewRun(
    reviewRunId,
    ReviewRunRepository.markFailed(reviewRunId, errorCode, errorMessage),
  );

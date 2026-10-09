import { Data, Match } from "effect";

import type { ReviewProvider } from "./catalog.js";

/**
 * Why a provider refused or failed a review request. Decides retries and
 * which message a workspace sees for its own key
 * (docs/MULTI_PROVIDER_BYOK_DESIGN.md, "Errors").
 */
export type ReviewFailureReason =
  | "key_rejected"
  | "quota_exceeded"
  | "model_unavailable"
  | "rate_limited"
  | "provider_unavailable"
  | "bad_request"
  | "request_failed";

export class ReviewProviderError extends Data.TaggedError(
  "ReviewProviderError",
)<{
  readonly provider: ReviewProvider;
  readonly reason: ReviewFailureReason;
  readonly status: number | null;
  readonly detail: string;
}> {}

/** The model answered, but not with a review matching the schema. */
export class ReviewOutputInvalidError extends Data.TaggedError(
  "ReviewOutputInvalidError",
)<{
  readonly provider: ReviewProvider;
  readonly detail: string;
}> {}

export class ReviewTimeoutError extends Data.TaggedError("ReviewTimeoutError")<{
  readonly timeoutMillis: number;
}> {}

export type ReviewerError =
  | ReviewProviderError
  | ReviewOutputInvalidError
  | ReviewTimeoutError;

const DETAIL_LIMIT = 500;

export const truncateDetail = (text: string) => text.slice(0, DETAIL_LIMIT);

/**
 * Sorts a provider's non-2xx answer by status and body. Provider bodies
 * never echo the key, so the body is safe to keep as detail.
 */
export const failureReasonFor = (
  provider: ReviewProvider,
  status: number,
  body: string,
): ReviewFailureReason => {
  const text = body.toLowerCase();

  if (status === 401) {
    return "key_rejected";
  }

  if (status === 403) {
    // OpenAI answers 403 when a key may not use a model (e.g. an
    // unverified organization); the key itself works.
    return provider === "openai" && text.includes("model")
      ? "model_unavailable"
      : "key_rejected";
  }

  if (status === 404) {
    return "model_unavailable";
  }

  if (status === 429) {
    return text.includes("insufficient_quota")
      ? "quota_exceeded"
      : "rate_limited";
  }

  if (status >= 500) {
    return "provider_unavailable";
  }

  if (status === 400) {
    // Anthropic reports an empty prepaid balance as a 400.
    if (text.includes("credit balance")) {
      return "quota_exceeded";
    }

    // Google reports a bad key as 400 API_KEY_INVALID.
    if (
      text.includes("api_key_invalid") ||
      text.includes("api key not valid")
    ) {
      return "key_rejected";
    }
  }

  return "bad_request";
};

export const providerErrorFor = (
  provider: ReviewProvider,
  status: number,
  body: string,
) =>
  new ReviewProviderError({
    provider,
    reason: failureReasonFor(provider, status, body),
    status,
    detail: truncateDetail(body),
  });

/** Worth another attempt: rate limits, outages, network failures, timeouts. */
export const isRetryableReviewerError = (error: ReviewerError) =>
  Match.value(error).pipe(
    Match.tag("ReviewProviderError", (failure) =>
      ["rate_limited", "provider_unavailable", "request_failed"].includes(
        failure.reason,
      ),
    ),
    Match.tag("ReviewTimeoutError", () => true),
    Match.tag("ReviewOutputInvalidError", () => false),
    Match.exhaustive,
  );

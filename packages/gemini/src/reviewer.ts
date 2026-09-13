import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Schedule,
  Schema,
} from "effect";

import { buildReviewUserPrompt, buildSystemPrompt } from "./prompt.js";
import { GeminiReview, geminiResponseJsonSchema } from "./schema.js";
import type { GeminiReviewInput } from "./prompt.js";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const DEFAULT_TIMEOUT_MILLIS = 60_000;

const DEFAULT_RETRY_BASE_MILLIS = 500;

const DEFAULT_MAX_RETRIES = 3;

// Low temperature keeps findings reproducible; the persona lives in the
// prompt, not in sampling randomness.
const GENERATION_TEMPERATURE = 0.2;

export class GeminiRequestError extends Data.TaggedError("GeminiRequestError")<{
  readonly cause: unknown;
}> {}

export class GeminiResponseError extends Data.TaggedError(
  "GeminiResponseError",
)<{
  readonly status: number;
  readonly body: string;
}> {}

export class GeminiResponseParseError extends Data.TaggedError(
  "GeminiResponseParseError",
)<{
  readonly cause: unknown;
}> {}

export class GeminiTimeoutError extends Data.TaggedError("GeminiTimeoutError")<{
  readonly timeoutMillis: number;
}> {}

export type GeminiReviewerError =
  | GeminiRequestError
  | GeminiResponseError
  | GeminiResponseParseError
  | GeminiTimeoutError;

const GenerateContentResponse = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
  usageMetadata: Schema.optional(
    Schema.Struct({
      promptTokenCount: Schema.optional(Schema.Number),
      candidatesTokenCount: Schema.optional(Schema.Number),
      totalTokenCount: Schema.optional(Schema.Number),
    }),
  ),
});

export interface GeminiUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface GeminiReviewResult {
  readonly review: GeminiReview;
  readonly model: string;
  readonly usage: GeminiUsage;
}

export interface GeminiReviewerService {
  readonly review: (
    input: GeminiReviewInput,
  ) => Effect.Effect<GeminiReviewResult, GeminiReviewerError>;
}

export class GeminiReviewer extends Context.Tag(
  "@not-quite-my-tempo/gemini/GeminiReviewer",
)<GeminiReviewer, GeminiReviewerService>() {}

export interface GeminiReviewerConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMillis?: number;
  readonly retryBaseMillis?: number;
  readonly maxRetries?: number;
}

const isRetryable = (error: GeminiReviewerError) =>
  Match.value(error).pipe(
    Match.tag(
      "GeminiResponseError",
      (failure) => failure.status === 429 || failure.status >= 500,
    ),
    Match.tag("GeminiRequestError", () => true),
    Match.tag("GeminiTimeoutError", () => true),
    Match.orElse(() => false),
  );

const requestReview = (
  config: GeminiReviewerConfig,
  input: GeminiReviewInput,
) =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl ?? GEMINI_API_BASE_URL;
    const model = config.model ?? DEFAULT_GEMINI_MODEL;

    const fetchImpl =
      config.fetchImpl ??
      ((requestInput: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(requestInput, init));

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`${baseUrl}/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": config.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: buildSystemPrompt(input.intensity) }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: buildReviewUserPrompt(input) }],
              },
            ],
            generationConfig: {
              temperature: GENERATION_TEMPERATURE,
              responseMimeType: "application/json",
              responseSchema: geminiResponseJsonSchema,
            },
          }),
        }),
      catch: (cause) => new GeminiRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new GeminiRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new GeminiResponseError({
        status: response.status,
        body,
      });
    }

    const envelope = yield* Schema.decodeUnknown(
      Schema.parseJson(GenerateContentResponse),
    )(body).pipe(
      Effect.mapError((cause) => new GeminiResponseParseError({ cause })),
    );

    const candidateText = envelope.candidates[0]?.content.parts
      .map((part) => part.text)
      .join("");

    const review = yield* Schema.decodeUnknown(Schema.parseJson(GeminiReview))(
      candidateText,
    ).pipe(Effect.mapError((cause) => new GeminiResponseParseError({ cause })));

    return {
      review,
      model,
      usage: {
        inputTokens: envelope.usageMetadata?.promptTokenCount ?? null,
        outputTokens: envelope.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: envelope.usageMetadata?.totalTokenCount ?? null,
      },
    };
  });

export const GeminiReviewerLive = (config: GeminiReviewerConfig) => {
  const timeoutMillis = config.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;

  const retrySchedule = Schedule.exponential(
    Duration.millis(config.retryBaseMillis ?? DEFAULT_RETRY_BASE_MILLIS),
  ).pipe(
    Schedule.jittered,
    Schedule.intersect(
      Schedule.recurs(config.maxRetries ?? DEFAULT_MAX_RETRIES),
    ),
  );

  return Layer.succeed(
    GeminiReviewer,
    GeminiReviewer.of({
      review: (input) =>
        requestReview(config, input).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMillis),
            onTimeout: () => new GeminiTimeoutError({ timeoutMillis }),
          }),
          Effect.retry({ schedule: retrySchedule, while: isRetryable }),
        ),
    }),
  );
};

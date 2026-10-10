import {
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Predicate,
  Schedule,
  Schema,
} from "effect";

import { findCatalogModel } from "./catalog.js";
import type { ReviewProvider } from "./catalog.js";
import {
  isRetryableReviewerError,
  providerErrorFor,
  ReviewOutputInvalidError,
  ReviewProviderError,
  ReviewTimeoutError,
  truncateDetail,
} from "./errors.js";
import type { ReviewerError } from "./errors.js";
import { buildReviewUserPrompt, buildSystemPrompt } from "./prompt.js";
import type { GeminiReviewInput } from "./prompt.js";
import {
  GeminiReview,
  geminiResponseJsonSchema,
  reviewJsonSchema,
} from "./schema.js";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

export const VERTEX_API_BASE_URL = "https://aiplatform.googleapis.com";

export const OPENAI_API_BASE_URL = "https://api.openai.com";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

const ANTHROPIC_VERSION = "2023-06-01";

/** The platform key's model when GEMINI_MODEL isn't set, and the trial's. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

// Overload answers (429/503) come back fast; give the provider a few
// seconds to recover rather than half a second.
const DEFAULT_RETRY_BASE_MILLIS = 2_000;

const DEFAULT_MAX_RETRIES = 3;

// Gemini 3.x models think before answering, and under load even a short
// prompt can take half a minute; 60s timed out real reviews. Reasoning
// models and long Claude reviews are slower still.
const DEFAULT_TIMEOUT_MILLIS: Readonly<Record<ReviewProvider, number>> = {
  gemini_api: 180_000,
  vertex_express: 180_000,
  openai: 180_000,
  anthropic: 180_000,
};

// Low temperature keeps findings reproducible; the persona lives in the
// prompt, not in sampling randomness. Reasoning models reject it, and
// Gemini 3+ isn't sent one: Google warns that values below 1.0 can make it
// loop or reason worse.
const GENERATION_TEMPERATURE = 0.2;

/**
 * How hard Gemini thinks before answering. Set explicitly rather than
 * left to each model's default (Flash-Lite's is "minimal", too little to
 * find bugs); "high" would add thinking tokens, billed as output.
 */
const geminiThinkingLevel = (model: string) =>
  model.includes("flash-lite") ? "low" : "medium";

// Enough for a long review; Anthropic requires an explicit cap.
const ANTHROPIC_MAX_TOKENS = 16_000;

// The name OpenAI and Anthropic see for the structured review.
const REVIEW_OBJECT_NAME = "fletcher_review";

export interface ReviewUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /**
   * Input tokens served from the provider's prompt cache, counted inside
   * `inputTokens`. Absent on results persisted before it was recorded.
   */
  readonly cachedInputTokens?: number | null;
}

export interface ReviewResult {
  readonly review: GeminiReview;
  readonly provider: ReviewProvider;
  readonly model: string;
  readonly usage: ReviewUsage;
}

export interface ReviewerService {
  readonly review: (
    input: GeminiReviewInput,
  ) => Effect.Effect<ReviewResult, ReviewerError>;
}

export class Reviewer extends Context.Tag(
  "@not-quite-my-tempo/reviewer/Reviewer",
)<Reviewer, ReviewerService>() {}

export interface ReviewerConfig {
  readonly provider: ReviewProvider;
  readonly apiKey: string;
  readonly model: string;
  /** Overrides the provider's API origin (tests). */
  readonly baseUrl?: string;
  /** Defaults to the global fetch; tests answer locally. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMillis?: number;
  readonly retryBaseMillis?: number;
  readonly maxRetries?: number;
}

interface ProviderReply {
  readonly reviewJson: string;
  readonly usage: ReviewUsage;
}

/** One provider call: where it goes, and how to read a 2xx reply. */
interface ProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly read: (
    body: string,
  ) => Effect.Effect<ProviderReply, ReviewOutputInvalidError>;
}

const OptionalCount = Schema.optional(Schema.Number);

const GeminiEnvelope = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
  usageMetadata: Schema.optional(
    Schema.Struct({
      promptTokenCount: OptionalCount,
      cachedContentTokenCount: OptionalCount,
      candidatesTokenCount: OptionalCount,
      totalTokenCount: OptionalCount,
    }),
  ),
});

const OpenAiEnvelope = Schema.Struct({
  status: Schema.optional(Schema.String),
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: OptionalCount,
      input_tokens_details: Schema.optional(
        Schema.Struct({ cached_tokens: OptionalCount }),
      ),
      output_tokens: OptionalCount,
      total_tokens: OptionalCount,
    }),
  ),
});

const AnthropicEnvelope = Schema.Struct({
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      name: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Unknown),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: OptionalCount,
      output_tokens: OptionalCount,
    }),
  ),
});

const invalidOutput = (provider: ReviewProvider, detail: string) =>
  new ReviewOutputInvalidError({ provider, detail: truncateDetail(detail) });

const decodeEnvelope =
  <A, I>(provider: ReviewProvider, schema: Schema.Schema<A, I>) =>
  (body: string) =>
    Schema.decodeUnknown(Schema.parseJson(schema))(body).pipe(
      Effect.mapError((cause) => invalidOutput(provider, cause.message)),
    );

const geminiRequest = (
  config: ReviewerConfig,
  input: GeminiReviewInput,
): ProviderRequest => ({
  url:
    config.provider === "vertex_express"
      ? `${config.baseUrl ?? VERTEX_API_BASE_URL}/v1/publishers/google/models/${config.model}:generateContent`
      : `${config.baseUrl ?? GEMINI_API_BASE_URL}/v1beta/models/${config.model}:generateContent`,
  headers: {
    "content-type": "application/json",
    "x-goog-api-key": config.apiKey,
  },
  body: JSON.stringify({
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(input.intensity, input.tone) }],
    },
    contents: [
      { role: "user", parts: [{ text: buildReviewUserPrompt(input) }] },
    ],
    generationConfig: {
      thinkingConfig: { thinkingLevel: geminiThinkingLevel(config.model) },
      responseMimeType: "application/json",
      responseSchema: geminiResponseJsonSchema,
    },
  }),
  read: (body) =>
    decodeEnvelope(
      config.provider,
      GeminiEnvelope,
    )(body).pipe(
      Effect.map((envelope) => ({
        reviewJson:
          envelope.candidates[0]?.content.parts
            .map((part) => part.text)
            .join("") ?? "",
        usage: {
          inputTokens: envelope.usageMetadata?.promptTokenCount ?? null,
          outputTokens: envelope.usageMetadata?.candidatesTokenCount ?? null,
          totalTokens: envelope.usageMetadata?.totalTokenCount ?? null,
          cachedInputTokens:
            envelope.usageMetadata?.cachedContentTokenCount ?? null,
        },
      })),
    ),
});

const openAiRequest = (
  config: ReviewerConfig,
  input: GeminiReviewInput,
): ProviderRequest => {
  // Every supported GPT model reasons and rejects temperature; own-key
  // models outside the catalog are treated the same.
  const sampling =
    findCatalogModel(config.model)?.reasoning === false
      ? { temperature: GENERATION_TEMPERATURE }
      : { reasoning: { effort: "low" } };

  return {
    url: `${config.baseUrl ?? OPENAI_API_BASE_URL}/v1/responses`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      instructions: buildSystemPrompt(input.intensity, input.tone),
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: buildReviewUserPrompt(input) }],
        },
      ],
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: REVIEW_OBJECT_NAME,
          strict: true,
          schema: reviewJsonSchema,
        },
      },
      ...sampling,
    }),
    read: (body) =>
      decodeEnvelope(
        config.provider,
        OpenAiEnvelope,
      )(body).pipe(
        Effect.flatMap((envelope) =>
          envelope.status !== undefined && envelope.status !== "completed"
            ? Effect.fail(
                invalidOutput(config.provider, `response ${envelope.status}`),
              )
            : Effect.succeed({
                reviewJson: envelope.output
                  .flatMap((item) =>
                    item.type === "message" ? (item.content ?? []) : [],
                  )
                  .flatMap((part) =>
                    part.type === "output_text" ? [part.text ?? ""] : [],
                  )
                  .join(""),
                usage: {
                  inputTokens: envelope.usage?.input_tokens ?? null,
                  outputTokens: envelope.usage?.output_tokens ?? null,
                  totalTokens: envelope.usage?.total_tokens ?? null,
                  cachedInputTokens:
                    envelope.usage?.input_tokens_details?.cached_tokens ?? null,
                },
              }),
        ),
      ),
  };
};

const anthropicRequest = (
  config: ReviewerConfig,
  input: GeminiReviewInput,
): ProviderRequest => ({
  url: `${config.baseUrl ?? ANTHROPIC_API_BASE_URL}/v1/messages`,
  headers: {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  },
  // Structured output through one forced tool call, which every Claude
  // model supports.
  body: JSON.stringify({
    model: config.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    temperature: GENERATION_TEMPERATURE,
    system: buildSystemPrompt(input.intensity, input.tone),
    messages: [{ role: "user", content: buildReviewUserPrompt(input) }],
    tools: [
      {
        name: REVIEW_OBJECT_NAME,
        description: "Fletcher's review of the pull request.",
        input_schema: reviewJsonSchema,
      },
    ],
    tool_choice: { type: "tool", name: REVIEW_OBJECT_NAME },
  }),
  read: (body) =>
    decodeEnvelope(
      config.provider,
      AnthropicEnvelope,
    )(body).pipe(
      Effect.flatMap((envelope) => {
        const call = envelope.content.find(
          (part) =>
            part.type === "tool_use" && part.name === REVIEW_OBJECT_NAME,
        );

        // A max_tokens stop leaves the tool input cut off.
        if (call === undefined || envelope.stop_reason === "max_tokens") {
          return Effect.fail(
            invalidOutput(
              config.provider,
              `no complete review (stop_reason ${envelope.stop_reason ?? "none"})`,
            ),
          );
        }

        const inputTokens = envelope.usage?.input_tokens ?? null;
        const outputTokens = envelope.usage?.output_tokens ?? null;

        return Effect.succeed({
          reviewJson: JSON.stringify(call.input ?? null),
          usage: {
            inputTokens,
            outputTokens,
            totalTokens:
              inputTokens === null || outputTokens === null
                ? null
                : inputTokens + outputTokens,
          },
        });
      }),
    ),
});

const providerRequest = (config: ReviewerConfig, input: GeminiReviewInput) =>
  Match.value(config.provider).pipe(
    Match.when("openai", () => openAiRequest(config, input)),
    Match.when("anthropic", () => anthropicRequest(config, input)),
    Match.orElse(() => geminiRequest(config, input)),
  );

const requestFailed = (
  provider: ReviewProvider,
  status: number | null,
  cause: Error | string,
) =>
  new ReviewProviderError({
    provider,
    reason: "request_failed",
    status,
    detail: truncateDetail(String(cause)),
  });

const requestReview = (config: ReviewerConfig, input: GeminiReviewInput) =>
  Effect.gen(function* () {
    const request = providerRequest(config, input);

    const fetchImpl =
      config.fetchImpl ??
      ((requestInput: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(requestInput, init));

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal,
        }),
      catch: (cause) => requestFailed(config.provider, null, String(cause)),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        requestFailed(config.provider, response.status, String(cause)),
    });

    if (!response.ok) {
      return yield* providerErrorFor(config.provider, response.status, body);
    }

    const reply = yield* request.read(body);

    const review = yield* Schema.decodeUnknown(Schema.parseJson(GeminiReview))(
      reply.reviewJson,
    ).pipe(
      Effect.mapError((cause) => invalidOutput(config.provider, cause.message)),
    );

    return {
      review,
      provider: config.provider,
      model: config.model,
      usage: reply.usage,
    } satisfies ReviewResult;
  });

/** A Reviewer for one provider, key, and model, built per review run. */
export const ReviewerLive = (config: ReviewerConfig) => {
  const timeoutMillis =
    config.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS[config.provider];

  const retrySchedule = Schedule.exponential(
    Duration.millis(config.retryBaseMillis ?? DEFAULT_RETRY_BASE_MILLIS),
  ).pipe(
    Schedule.jittered,
    Schedule.intersect(
      Schedule.recurs(config.maxRetries ?? DEFAULT_MAX_RETRIES),
    ),
  );

  return Layer.succeed(
    Reviewer,
    Reviewer.of({
      review: (input) =>
        requestReview(config, input).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMillis),
            onTimeout: () => new ReviewTimeoutError({ timeoutMillis }),
          }),
          // A timed-out attempt is not repeated here: the provider may
          // still bill it, and an immediate retry hits the same load. The
          // Workflow retries the whole step later instead.
          Effect.retry({
            schedule: retrySchedule,
            while: (error) =>
              !Predicate.isTagged(error, "ReviewTimeoutError") &&
              isRetryableReviewerError(error),
          }),
        ),
    }),
  );
};

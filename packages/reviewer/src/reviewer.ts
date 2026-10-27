import {
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";

import { reviewEffort } from "./catalog.js";
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
import {
  buildFocusedUserPrompt,
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  buildReviewUserPrompt,
  buildSystemPrompt,
  buildVerificationSystemPrompt,
  buildVerificationUserPrompt,
  SPECIALIST_FOCUSES,
} from "./prompt.js";
import type { GeminiReviewInput } from "./prompt.js";
import type { GeminiFinding } from "./schema.js";
import {
  CandidateVerification,
  GeminiReview,
  geminiResponseJsonSchema,
  geminiVerificationJsonSchema,
  reviewJsonSchema,
  verdictForFindings,
  verificationJsonSchema,
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

// Doubling waits are capped so a run of rate limits can't stretch one
// review past its step's time limit.
const DEFAULT_MAX_RETRY_DELAY_MILLIS = 30_000;

// Gemini 3.x models think before answering, and under load even a short
// prompt can take half a minute; 60s timed out real reviews. How long a
// review takes follows how long the model thinks, not the prompt size: on
// the Martian benchmark a 39k-token prompt thought for 43k tokens and hit
// 180s on every attempt, then finished within 360s. Seven minutes leaves
// the run-review step (10 minutes) room to fetch repository context first.
const DEFAULT_TIMEOUT_MILLIS: Readonly<Record<ReviewProvider, number>> = {
  gemini_api: 420_000,
  vertex_express: 420_000,
  openai: 420_000,
  anthropic: 420_000,
};

// Verification only checks candidates already found, and the run-review
// step must fit both calls plus the repository context fetch in its 10
// minutes. When it runs out, the unverified candidates are published.
const DEFAULT_VERIFICATION_TIMEOUT_MILLIS = 150_000;

// No request sets a temperature. Every supported model reasons before it
// answers: Claude 5.5+ and GPT reasoning models reject sampling settings,
// and Google warns that Gemini 3+ below 1.0 can loop or reason worse. How
// hard each model thinks comes from the catalog's `effort` instead.

// Anthropic requires an explicit cap, and thinking counts toward it: room
// for a long review plus high-effort thinking on a large diff.
const ANTHROPIC_MAX_TOKENS = 32_000;

/** The JSON shape a call must answer in, per provider dialect. */
interface OutputFormat {
  /** The name OpenAI sees for the structured output. */
  readonly name: string;
  readonly gemini: object;
  readonly json: object;
}

const REVIEW_OUTPUT: OutputFormat = {
  name: "fletcher_review",
  gemini: geminiResponseJsonSchema,
  json: reviewJsonSchema,
};

const VERIFICATION_OUTPUT: OutputFormat = {
  name: "fletcher_verification",
  gemini: geminiVerificationJsonSchema,
  json: verificationJsonSchema,
};

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

/**
 * What happened to the candidate findings. "unverified" means the verifier
 * failed and the candidates were published as found.
 */
export type ReviewVerification =
  | { readonly status: "not_needed" }
  | {
      readonly status: "verified";
      readonly candidates: number;
      readonly kept: number;
    }
  | {
      readonly status: "unverified";
      readonly candidates: number;
      readonly reason: string;
    };

/** How a specialist review's passes went and what their merge kept. */
export interface ReviewFanOut {
  readonly passes: number;
  readonly failedPasses: number;
  readonly candidates: number;
  readonly kept: number;
  /** "unmerged": the merge failed, so exact duplicates alone were removed. */
  readonly merge: "merged" | "unmerged" | "not_needed";
}

export interface ReviewResult {
  readonly review: GeminiReview;
  readonly provider: ReviewProvider;
  readonly model: string;
  readonly usage: ReviewUsage;
  /** Absent on results persisted before verification existed. */
  readonly verification?: ReviewVerification;
  /** Present only on specialist reviews. */
  readonly fanOut?: ReviewFanOut;
}

/**
 * "single": one review call, then a verification pass over its findings.
 * "specialists": one call per specialist focus in parallel, their findings
 * merged and deduplicated, with no verification.
 */
export type ReviewStrategy = "single" | "specialists";

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
  /**
   * The Google Cloud project behind a Vertex AI express key. When known,
   * calls go to the global location, which serves models us-central1
   * doesn't (see detectVertexProject).
   */
  readonly vertexProject?: string;
  /** Overrides the provider's API origin (tests). */
  readonly baseUrl?: string;
  /** Defaults to the global fetch; tests answer locally. */
  readonly fetchImpl?: typeof fetch;
  /** Per attempt at the review itself. */
  readonly timeoutMillis?: number;
  /** For the whole verification (or merge) stage, retries included. */
  readonly verificationTimeoutMillis?: number;
  /** Defaults to "single". */
  readonly strategy?: ReviewStrategy;
  readonly retryBaseMillis?: number;
  readonly maxRetries?: number;
  /** The longest wait between retries. */
  readonly maxRetryDelayMillis?: number;
  /**
   * For each specialist pass, retries included; a pass past it counts as
   * failed and the others' findings are kept. Unset, a pass is bounded only
   * per attempt.
   */
  readonly passDeadlineMillis?: number;
}

interface ReviewPrompts {
  readonly system: string;
  readonly user: string;
  readonly output: OutputFormat;
}

interface ProviderReply {
  readonly json: string;
  readonly usage: ReviewUsage;
}

/** One provider call: where it goes, and how to read a 2xx reply. */
interface ProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly read: (
    body: string,
  ) => Effect.Effect<
    ProviderReply,
    ReviewOutputInvalidError | ReviewProviderError
  >;
}

const OptionalCount = Schema.optional(Schema.Number);

// One event of a streamGenerateContent reply. Chunks may carry no text
// (the last often holds only usage), and usage counts are cumulative.
const GeminiChunk = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  text: Schema.optional(Schema.String),
                  thought: Schema.optional(Schema.Boolean),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
  usageMetadata: Schema.optional(
    Schema.Struct({
      promptTokenCount: OptionalCount,
      cachedContentTokenCount: OptionalCount,
      candidatesTokenCount: OptionalCount,
      thoughtsTokenCount: OptionalCount,
      totalTokenCount: OptionalCount,
    }),
  ),
});

// A failure Google reports inside the stream, after a 200 status.
const GeminiStreamError = Schema.Struct({
  error: Schema.Struct({ code: Schema.Number }),
});

type GeminiUsage = (typeof GeminiChunk.Type)["usageMetadata"];

/** The data of each server-sent event in a fully read stream, in order. */
const serverSentEventData = (body: string) =>
  body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));

    return data.length === 0 ? [] : [data.join("\n")];
  });

// Gemini reports thinking apart from the answer but bills both as output.
// OpenAI and Anthropic already count reasoning in their output totals.
const geminiOutputTokens = (usage: GeminiUsage) => {
  const answer = usage?.candidatesTokenCount;
  const thinking = usage?.thoughtsTokenCount;

  return answer === undefined && thinking === undefined
    ? null
    : (answer ?? 0) + (thinking ?? 0);
};

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
      text: Schema.optional(Schema.String),
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

// Streamed, though the reply is still read whole: Cloudflare answers 524
// when response headers take longer than about 100 seconds, and a model
// thinking through a large diff takes longer than that to answer at all.
// Google sends a stream's headers with its first part, which comes only
// after thinking unless thought summaries are streamed too (includeThoughts
// below): on PR #30's diff, headers came at 221s without them and 37s with.
const GEMINI_METHOD = "streamGenerateContent?alt=sse";

const geminiUrl = (config: ReviewerConfig) => {
  if (config.provider !== "vertex_express") {
    return `${config.baseUrl ?? GEMINI_API_BASE_URL}/v1beta/models/${config.model}:${GEMINI_METHOD}`;
  }

  const base = config.baseUrl ?? VERTEX_API_BASE_URL;

  return config.vertexProject === undefined
    ? `${base}/v1/publishers/google/models/${config.model}:${GEMINI_METHOD}`
    : `${base}/v1/projects/${config.vertexProject}/locations/global/publishers/google/models/${config.model}:${GEMINI_METHOD}`;
};

const readGeminiStream = (provider: ReviewProvider, body: string) =>
  Effect.gen(function* () {
    const events = serverSentEventData(body);

    if (events.length === 0) {
      return yield* invalidOutput(provider, "empty stream");
    }

    let json = "";
    let usage: GeminiUsage = undefined;

    for (const data of events) {
      const streamError = yield* Schema.decodeUnknown(
        Schema.parseJson(GeminiStreamError),
      )(data).pipe(Effect.option);

      if (Option.isSome(streamError)) {
        return yield* providerErrorFor(
          provider,
          streamError.value.error.code,
          data,
        );
      }

      const chunk = yield* decodeEnvelope(provider, GeminiChunk)(data);

      json +=
        chunk.candidates?.[0]?.content?.parts
          ?.flatMap((part) => (part.thought === true ? [] : [part.text ?? ""]))
          .join("") ?? "";
      usage = chunk.usageMetadata ?? usage;
    }

    return {
      json,
      usage: {
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: geminiOutputTokens(usage),
        totalTokens: usage?.totalTokenCount ?? null,
        cachedInputTokens: usage?.cachedContentTokenCount ?? null,
      },
    };
  });

const geminiRequest = (
  config: ReviewerConfig,
  prompts: ReviewPrompts,
): ProviderRequest => ({
  url: geminiUrl(config),
  headers: {
    "content-type": "application/json",
    "x-goog-api-key": config.apiKey,
  },
  body: JSON.stringify({
    systemInstruction: {
      parts: [{ text: prompts.system }],
    },
    contents: [{ role: "user", parts: [{ text: prompts.user }] }],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: reviewEffort(config.model),
        // Streams thought summaries so headers arrive early (GEMINI_METHOD);
        // readGeminiStream leaves them out of the review.
        includeThoughts: true,
      },
      responseMimeType: "application/json",
      responseSchema: prompts.output.gemini,
    },
  }),
  read: (body) => readGeminiStream(config.provider, body),
});

const openAiRequest = (
  config: ReviewerConfig,
  prompts: ReviewPrompts,
): ProviderRequest => ({
  url: `${config.baseUrl ?? OPENAI_API_BASE_URL}/v1/responses`,
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  },
  body: JSON.stringify({
    model: config.model,
    instructions: prompts.system,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompts.user }],
      },
    ],
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: prompts.output.name,
        strict: true,
        schema: prompts.output.json,
      },
    },
    reasoning: { effort: reviewEffort(config.model) },
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
              json: envelope.output
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
});

// Claude 5.5+ rejects forced tool use and sampling settings, and always
// thinks (adaptive); effort sets how hard. The review comes back as JSON
// text constrained to the schema.
const anthropicRequest = (
  config: ReviewerConfig,
  prompts: ReviewPrompts,
): ProviderRequest => ({
  url: `${config.baseUrl ?? ANTHROPIC_API_BASE_URL}/v1/messages`,
  headers: {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  },
  body: JSON.stringify({
    model: config.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: prompts.system,
    messages: [{ role: "user", content: prompts.user }],
    output_config: {
      effort: reviewEffort(config.model),
      format: { type: "json_schema", schema: prompts.output.json },
    },
  }),
  read: (body) =>
    decodeEnvelope(
      config.provider,
      AnthropicEnvelope,
    )(body).pipe(
      Effect.flatMap((envelope) => {
        // A refusal or a max_tokens stop leaves no schema-valid review.
        if (envelope.stop_reason !== "end_turn") {
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
          json: envelope.content
            .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
            .join(""),
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

const providerRequest = (config: ReviewerConfig, prompts: ReviewPrompts) =>
  Match.value(config.provider).pipe(
    Match.when("openai", () => openAiRequest(config, prompts)),
    Match.when("anthropic", () => anthropicRequest(config, prompts)),
    Match.orElse(() => geminiRequest(config, prompts)),
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

const requestStructured = <A, I>(
  config: ReviewerConfig,
  prompts: ReviewPrompts,
  schema: Schema.Schema<A, I>,
) =>
  Effect.gen(function* () {
    const request = providerRequest(config, prompts);

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

    const value = yield* Schema.decodeUnknown(Schema.parseJson(schema))(
      reply.json,
    ).pipe(
      Effect.mapError((cause) => invalidOutput(config.provider, cause.message)),
    );

    return { value, usage: reply.usage };
  });

const sumUsage = (
  left: number | null | undefined,
  right: number | null | undefined,
) => (left == null || right == null ? null : left + right);

const combineUsage = (usages: readonly ReviewUsage[]): ReviewUsage =>
  usages.reduce((total, usage) => ({
    inputTokens: sumUsage(total.inputTokens, usage.inputTokens),
    outputTokens: sumUsage(total.outputTokens, usage.outputTokens),
    totalTokens: sumUsage(total.totalTokens, usage.totalTokens),
    cachedInputTokens: sumUsage(
      total.cachedInputTokens,
      usage.cachedInputTokens,
    ),
  }));

// Without a merge, only findings that are identical in place and title are
// known to be the same defect.
const exactDuplicateKey = (finding: GeminiFinding) =>
  JSON.stringify([finding.filePath, finding.line, finding.title]);

const describeFailure = (error: ReviewerError) =>
  Match.value(error).pipe(
    Match.tag(
      "ReviewProviderError",
      (failure) => `${failure.reason} (${failure.status ?? "no status"})`,
    ),
    Match.orElse((failure) => failure._tag),
  );

/** A Reviewer for one provider, key, and model, built per review run. */
export const ReviewerLive = (config: ReviewerConfig) => {
  const timeoutMillis =
    config.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS[config.provider];

  const retrySchedule = Schedule.exponential(
    Duration.millis(config.retryBaseMillis ?? DEFAULT_RETRY_BASE_MILLIS),
  ).pipe(
    Schedule.union(
      Schedule.spaced(
        Duration.millis(
          config.maxRetryDelayMillis ?? DEFAULT_MAX_RETRY_DELAY_MILLIS,
        ),
      ),
    ),
    Schedule.jittered,
    Schedule.intersect(
      Schedule.recurs(config.maxRetries ?? DEFAULT_MAX_RETRIES),
    ),
  );

  const verificationTimeoutMillis =
    config.verificationTimeoutMillis ?? DEFAULT_VERIFICATION_TIMEOUT_MILLIS;

  const retried = <A, E extends ReviewerError, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      // Every failed call is logged, so a slow review says what it waited on.
      Effect.tapError((error) =>
        Effect.logWarning("model call failed", {
          provider: config.provider,
          error: describeFailure(error),
        }),
      ),
      // A timed-out attempt is not repeated here: the provider may still
      // bill it, and an immediate retry hits the same load. The Workflow
      // retries the whole step later instead.
      Effect.retry({
        schedule: retrySchedule,
        while: (error) =>
          !Predicate.isTagged(error, "ReviewTimeoutError") &&
          isRetryableReviewerError(error),
      }),
    );

  const findCandidates = (
    input: GeminiReviewInput,
    user = buildReviewUserPrompt(input),
  ) =>
    retried(
      requestStructured(
        config,
        {
          system: buildSystemPrompt(input.intensity, input.tone),
          user,
          output: REVIEW_OUTPUT,
        },
        GeminiReview,
      ).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMillis),
          onTimeout: () => new ReviewTimeoutError({ timeoutMillis }),
        }),
      ),
    );

  // Asks which of `count` numbered candidates to keep (verification, or a
  // merge), within the stage's own budget.
  const chooseCandidates = (system: string, user: string, count: number) =>
    retried(
      requestStructured(
        config,
        { system, user, output: VERIFICATION_OUTPUT },
        CandidateVerification,
      ),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(verificationTimeoutMillis),
        onTimeout: () =>
          new ReviewTimeoutError({ timeoutMillis: verificationTimeoutMillis }),
      }),
      Effect.flatMap((reply) =>
        reply.value.keep.every((index) => index < count)
          ? Effect.succeed(reply)
          : Effect.fail(
              invalidOutput(
                config.provider,
                `kept an unknown candidate: ${JSON.stringify(reply.value.keep)}`,
              ),
            ),
      ),
    );

  const verify = (input: GeminiReviewInput, candidates: GeminiReview) =>
    chooseCandidates(
      buildVerificationSystemPrompt(input.intensity, input.tone),
      buildVerificationUserPrompt(input, candidates),
      candidates.findings.length,
    );

  const withPassDeadline = <A, R>(
    pass: Effect.Effect<A, ReviewerError, R>,
  ): Effect.Effect<A, ReviewerError, R> => {
    const deadline = config.passDeadlineMillis;

    return deadline === undefined
      ? pass
      : pass.pipe(
          Effect.timeoutFail({
            duration: Duration.millis(deadline),
            onTimeout: () =>
              new ReviewTimeoutError({ timeoutMillis: deadline }),
          }),
        );
  };

  const reviewWithSpecialists = (input: GeminiReviewInput) =>
    Effect.gen(function* () {
      const [failures, passes] = yield* Effect.partition(
        SPECIALIST_FOCUSES,
        (focus) =>
          withPassDeadline(
            findCandidates(input, buildFocusedUserPrompt(input, focus)),
          ),
        { concurrency: "unbounded" },
      );

      const [firstPass] = passes;

      // One pass's findings are still a review; only all failing loses it.
      if (firstPass === undefined) {
        return yield* Effect.fail(
          failures[0] ??
            invalidOutput(config.provider, "no specialist pass ran"),
        );
      }

      if (failures.length > 0) {
        yield* Effect.logWarning("specialist passes failed", {
          provider: config.provider,
          errors: failures.map((error) => error._tag),
        });
      }

      const candidates = passes.flatMap((pass) => pass.value.findings);

      const passUsage = combineUsage(passes.map((pass) => pass.usage));

      const fanOut = {
        passes: SPECIALIST_FOCUSES.length,
        failedPasses: failures.length,
        candidates: candidates.length,
      };

      const result = { provider: config.provider, model: config.model };

      if (candidates.length <= 1) {
        return {
          ...result,
          review: {
            summary: firstPass.value.summary,
            findings: candidates,
            verdict: verdictForFindings(candidates),
          },
          usage: passUsage,
          fanOut: { ...fanOut, kept: candidates.length, merge: "not_needed" },
        } satisfies ReviewResult;
      }

      return yield* chooseCandidates(
        buildMergeSystemPrompt(input.intensity, input.tone),
        buildMergeUserPrompt(input, candidates),
        candidates.length,
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const seen = new Set<string>();

            const findings = candidates.filter((finding) => {
              const key = exactDuplicateKey(finding);

              return seen.has(key) ? false : (seen.add(key), true);
            });

            return Effect.logWarning(
              "merge failed; removing exact duplicates",
              {
                provider: config.provider,
                error: error._tag,
              },
            ).pipe(
              Effect.as({
                ...result,
                review: {
                  summary: firstPass.value.summary,
                  findings,
                  verdict: verdictForFindings(findings),
                },
                usage: passUsage,
                fanOut: { ...fanOut, kept: findings.length, merge: "unmerged" },
              } satisfies ReviewResult),
            );
          },
          onSuccess: (merged) => {
            // In the merge's order (most important first), each kept once.
            const findings = [...new Set(merged.value.keep)].flatMap(
              (index) => {
                const finding = candidates[index];

                return finding === undefined ? [] : [finding];
              },
            );

            return Effect.succeed({
              ...result,
              review: {
                summary: merged.value.summary,
                findings,
                verdict: verdictForFindings(findings),
              },
              usage: combineUsage([passUsage, merged.usage]),
              fanOut: { ...fanOut, kept: findings.length, merge: "merged" },
            } satisfies ReviewResult);
          },
        }),
      );
    });

  const reviewOnce = (input: GeminiReviewInput) =>
    Effect.gen(function* () {
      const found = yield* findCandidates(input);

      const candidates = found.value;

      const result = { provider: config.provider, model: config.model };

      if (candidates.findings.length === 0) {
        return {
          ...result,
          review: { ...candidates, verdict: "good_job" },
          usage: found.usage,
          verification: { status: "not_needed" },
        } satisfies ReviewResult;
      }

      return yield* verify(input, candidates).pipe(
        Effect.matchEffect({
          // Candidates are a complete review on their own; a verifier
          // failure publishes them as found rather than losing the review.
          onFailure: (error) =>
            Effect.logWarning("verification failed; publishing candidates", {
              provider: config.provider,
              error: error._tag,
            }).pipe(
              Effect.as({
                ...result,
                review: {
                  ...candidates,
                  verdict: verdictForFindings(candidates.findings),
                },
                usage: found.usage,
                verification: {
                  status: "unverified",
                  candidates: candidates.findings.length,
                  reason: error._tag,
                },
              } satisfies ReviewResult),
            ),
          onSuccess: (verified) => {
            const keep = new Set(verified.value.keep);

            const findings = candidates.findings.filter((_, index) =>
              keep.has(index),
            );

            return Effect.succeed({
              ...result,
              review: {
                // Untouched candidates keep the summary that introduced them.
                summary:
                  findings.length === candidates.findings.length
                    ? candidates.summary
                    : verified.value.summary,
                findings,
                verdict: verdictForFindings(findings),
              },
              usage: combineUsage([found.usage, verified.usage]),
              verification: {
                status: "verified",
                candidates: candidates.findings.length,
                kept: findings.length,
              },
            } satisfies ReviewResult);
          },
        }),
      );
    });

  const review =
    config.strategy === "specialists" ? reviewWithSpecialists : reviewOnce;

  return Layer.succeed(Reviewer, Reviewer.of({ review }));
};

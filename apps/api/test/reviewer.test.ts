import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
  buildVerificationSystemPrompt,
  filterReviewBySeverity,
  FLETCHER_RUTHLESS_SYSTEM_PROMPT,
  FLETCHER_SYSTEM_PROMPT,
  GeminiReview,
  Reviewer,
  ReviewerLive,
} from "@not-quite-my-tempo/reviewer";
import type {
  GeminiReviewInput,
  ReviewerConfig,
} from "@not-quite-my-tempo/reviewer";

const input: GeminiReviewInput = {
  repository: "shaffer/studio-band",
  pullRequestNumber: 42,
  title: "Play Caravan at 240",
  body: "Double time swing.",
  diff: "diff --git a/src/tempo.ts b/src/tempo.ts",
  priorReview: null,
  context: null,
  intensity: "studio_band",
  tone: "standard",
};

const reviewJson = {
  verdict: "almost",
  summary: "Not quite my tempo. The intent is right; the execution drags.",
  findings: [
    {
      filePath: "src/tempo.ts",
      line: 14,
      severity: "warning",
      category: "correctness",
      confidence: 0.8,
      title: "Off-by-one in beat subdivision",
      message:
        "countOff multiplies before validating subdivision; guard zero first.",
    },
  ],
};

// What the verifier answers when every candidate survives.
const keepAll = { keep: [0], summary: "Verified. Still dragging." };

type ReviewPayload =
  | typeof reviewJson
  | { readonly verdict: string }
  | { readonly keep: readonly number[]; readonly summary: string };

const geminiUsage = {
  promptTokenCount: 1200,
  candidatesTokenCount: 300,
  totalTokenCount: 1500,
};

const geminiResponse = (
  review: ReviewPayload = reviewJson,
  usageMetadata:
    | (typeof geminiUsage & {
        readonly cachedContentTokenCount?: number;
        readonly thoughtsTokenCount?: number;
      })
    | null = geminiUsage,
) => {
  const text = JSON.stringify(review);
  const half = Math.floor(text.length / 2);

  // As streamGenerateContent sends it: the review split across chunks, and
  // usage only on the last one.
  return geminiStream([
    { candidates: [{ content: { role: "model", parts: [{ text: "" }] } }] },
    {
      candidates: [
        { content: { role: "model", parts: [{ text: text.slice(0, half) }] } },
      ],
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: text.slice(half) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: usageMetadata ?? undefined,
    },
  ]);
};

const geminiStream = (events: ReadonlyArray<unknown>) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const openAiResponse = (payload: ReviewPayload = reviewJson) =>
  new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1_790_000_000,
      model: "gpt-6.1-sol",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(payload),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 2000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 200 },
        total_tokens: 2500,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

const anthropicResponse = (
  stopReason = "end_turn",
  payload: ReviewPayload = reviewJson,
) =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [
        // Thinking text is omitted by default; only the review is read.
        { type: "thinking", thinking: "", signature: "sig_1" },
        { type: "text", text: JSON.stringify(payload) },
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1800, output_tokens: 400 },
    }),
    { headers: { "content-type": "application/json" } },
  );

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

// Answers every provider call locally, recording what was sent, and tells
// the answer whether the call is the verification pass.
const fakeFetch = (
  answer: (
    call: number,
    verifying: boolean,
    body: string,
  ) => Response | Promise<Response>,
  requests: RecordedRequest[] = [],
) => {
  let calls = 0;

  const fetchImpl: typeof fetch = async (url, init) => {
    calls += 1;

    const body = String(init?.body);

    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(body),
    });

    return answer(calls, body.includes("CANDIDATE VERIFICATION"), body);
  };

  return { fetchImpl, calls: () => calls };
};

interface ReviewRun extends Partial<Omit<ReviewerConfig, "fetchImpl">> {
  readonly fetch: ReturnType<typeof fakeFetch>;
}

const runReview = ({ fetch, ...overrides }: ReviewRun) =>
  Effect.gen(function* () {
    const reviewer = yield* Reviewer;

    return yield* reviewer.review(input);
  }).pipe(
    Effect.provide(
      ReviewerLive({
        provider: "gemini_api",
        apiKey: "test-api-key",
        model: "gemini-3.8-flash",
        retryBaseMillis: 1,
        fetchImpl: fetch.fetchImpl,
        ...overrides,
      }),
    ),
  );

describe("Reviewer on the Gemini API", () => {
  it("sends a structured-output request to the configured model", async () => {
    const requests: RecordedRequest[] = [];

    const result = await Effect.runPromise(
      runReview({
        baseUrl: "https://gemini.test",
        fetch: fakeFetch(() => geminiResponse(), requests),
      }),
    );

    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.provider).toBe("gemini_api");
    expect(requests[0]?.url).toBe(
      "https://gemini.test/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("test-api-key");

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
      generationConfig: {
        responseMimeType: string;
        responseSchema: { required: string[] };
        temperature?: number;
        thinkingConfig: { thinkingLevel: string; includeThoughts: boolean };
      };
    };

    expect(body.systemInstruction.parts[0]?.text).toBe(FLETCHER_SYSTEM_PROMPT);
    expect(body.contents[0]?.parts[0]?.text).toBe(buildReviewUserPrompt(input));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual([
      "verdict",
      "summary",
      "findings",
    ]);
    expect(body.generationConfig.temperature).toBeUndefined();
    // Thought summaries stream before the answer, so headers arrive early.
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "medium",
      includeThoughts: true,
    });
  });

  it("gives Flash-Lite models a low thinking level", async () => {
    const requests: RecordedRequest[] = [];

    await Effect.runPromise(
      runReview({
        model: "gemini-3.5-flash-lite",
        fetch: fakeFetch(() => geminiResponse(), requests),
      }),
    );

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };

    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });

  it("thinks hardest on pro models and at medium off the catalog", async () => {
    const requests: RecordedRequest[] = [];

    for (const model of ["gemini-4-argon", "gemini-3.9-flash"]) {
      await Effect.runPromise(
        runReview({
          model,
          fetch: fakeFetch(() => geminiResponse(), requests),
        }),
      );
    }

    // SAFETY: fakeFetch recorded the JSON bodies Fletcher sent.

    const levels = requests.map(
      (request) =>
        (
          request.body as {
            generationConfig: { thinkingConfig: { thinkingLevel: string } };
          }
        ).generationConfig.thinkingConfig.thinkingLevel,
    );

    expect(levels).toEqual(["high", "high", "medium", "medium"]);
  });

  it("sends Vertex AI keys to Vertex AI's express endpoint", async () => {
    const requests: RecordedRequest[] = [];

    await Effect.runPromise(
      runReview({
        provider: "vertex_express",
        fetch: fakeFetch(() => geminiResponse(), requests),
      }),
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    ]);
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("test-api-key");
  });

  it("sends Vertex AI keys with a known project to the global location", async () => {
    const requests: RecordedRequest[] = [];

    await Effect.runPromise(
      runReview({
        provider: "vertex_express",
        model: "gemini-4-argon",
        vertexProject: "778137311135",
        fetch: fakeFetch(() => geminiResponse(), requests),
      }),
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://aiplatform.googleapis.com/v1/projects/778137311135/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse",
      "https://aiplatform.googleapis.com/v1/projects/778137311135/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse",
    ]);
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("test-api-key");
  });

  it("decodes the reply into a review with usage", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch((_, verifying) =>
          geminiResponse(verifying ? keepAll : reviewJson),
        ),
      }),
    );

    expect(result.review).toEqual(reviewJson);
    expect(result.usage).toEqual({
      inputTokens: 2400,
      outputTokens: 600,
      totalTokens: 3000,
      cachedInputTokens: null,
    });
  });

  it("reports tokens served from Gemini's implicit cache", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch((_, verifying) =>
          geminiResponse(verifying ? keepAll : reviewJson, {
            ...geminiUsage,
            cachedContentTokenCount: 800,
          }),
        ),
      }),
    );

    expect(result.usage.cachedInputTokens).toBe(1600);
  });

  it("counts Gemini's thinking tokens as output, as they are billed", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch((_, verifying) =>
          geminiResponse(verifying ? keepAll : reviewJson, {
            ...geminiUsage,
            thoughtsTokenCount: 900,
            totalTokenCount: 2400,
          }),
        ),
      }),
    );

    expect(result.usage).toEqual({
      inputTokens: 2400,
      outputTokens: 2400,
      totalTokens: 4800,
      cachedInputTokens: null,
    });
  });

  it("returns null usage when the response omits it", async () => {
    const result = await Effect.runPromise(
      runReview({ fetch: fakeFetch(() => geminiResponse(reviewJson, null)) }),
    );

    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
    });
  });

  it("retries rate limits and succeeds on a later attempt", async () => {
    const fetch = fakeFetch((call) =>
      call === 1
        ? new Response("slow down", { status: 429 })
        : geminiResponse(),
    );

    const result = await Effect.runPromise(runReview({ fetch }));

    expect(fetch.calls()).toBe(3);
    expect(result.review.verdict).toBe("almost");
  });

  it("retries an overload Google reports inside the stream", async () => {
    const fetch = fakeFetch((call) =>
      call === 1
        ? geminiStream([
            { candidates: [{ content: { parts: [{ text: '{"verd' }] } }] },
            {
              error: {
                code: 503,
                message: "overloaded",
                status: "UNAVAILABLE",
              },
            },
          ])
        : geminiResponse(),
    );

    const result = await Effect.runPromise(runReview({ fetch }));

    expect(fetch.calls()).toBe(3);
    expect(result.review).toEqual(reviewJson);
  });

  it("leaves thought parts out of the review", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch(() =>
          geminiStream([
            {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "Counting off the tempo...", thought: true },
                      { text: JSON.stringify(reviewJson) },
                    ],
                  },
                },
              ],
            },
          ]),
        ),
      }),
    );

    expect(result.review).toEqual(reviewJson);
  });

  it("fails as invalid output when the stream is empty", async () => {
    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetch: fakeFetch(() => geminiStream([])) })),
    );

    expect(error._tag).toBe("ReviewOutputInvalidError");
  });

  it("reports a rejected key without retrying", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "API key not valid.",
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400 },
        ),
    );

    const error = await Effect.runPromise(Effect.flip(runReview({ fetch })));

    expect(fetch.calls()).toBe(1);
    expect(error._tag).toBe("ReviewProviderError");
    expect(error).toMatchObject({
      reason: "key_rejected",
      status: 400,
    });
  });

  it("does not retry other client errors", async () => {
    const fetch = fakeFetch(() => new Response("bad request", { status: 400 }));

    const error = await Effect.runPromise(Effect.flip(runReview({ fetch })));

    expect(fetch.calls()).toBe(1);
    expect(error._tag).toBe("ReviewProviderError");
    expect(error).toMatchObject({
      reason: "bad_request",
    });
  });

  it("gives up after exhausting retries", async () => {
    const fetch = fakeFetch(() => new Response("unavailable", { status: 503 }));

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetch, maxRetries: 2 })),
    );

    expect(fetch.calls()).toBe(3);
    expect(error._tag).toBe("ReviewProviderError");
    expect(error).toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("fails as invalid output when the reply is not a valid review", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          fetch: fakeFetch(() => geminiResponse({ verdict: "loud" })),
        }),
      ),
    );

    expect(error._tag).toBe("ReviewOutputInvalidError");
  });

  it("rejects reviews that break the schema's refinements", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          fetch: fakeFetch(() =>
            geminiResponse({ ...reviewJson, summary: "" }),
          ),
        }),
      ),
    );

    expect(error._tag).toBe("ReviewOutputInvalidError");
  });

  it("fails with a timeout error when the request hangs", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          fetch: fakeFetch(
            () =>
              new Promise<Response>(() => {
                // Never resolves; the reviewer's timeout must fire.
              }),
          ),
          timeoutMillis: 20,
          maxRetries: 0,
        }),
      ),
    );

    expect(error._tag).toBe("ReviewTimeoutError");
    expect(error).toMatchObject({
      timeoutMillis: 20,
    });
  });

  it("leaves a timed-out request to the Workflow instead of retrying it at once", async () => {
    const fetch = fakeFetch(
      () =>
        new Promise<Response>(() => {
          // Never resolves.
        }),
    );

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetch, timeoutMillis: 20, maxRetries: 3 })),
    );

    expect(error._tag).toBe("ReviewTimeoutError");
    expect(fetch.calls()).toBe(1);
  });
});

describe("Reviewer on OpenAI", () => {
  it("sends a strict JSON-schema Responses request at the model's effort", async () => {
    const requests: RecordedRequest[] = [];

    const result = await Effect.runPromise(
      runReview({
        provider: "openai",
        model: "gpt-6.1-sol",
        fetch: fakeFetch(
          (_, verifying) => openAiResponse(verifying ? keepAll : reviewJson),
          requests,
        ),
      }),
    );

    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer test-api-key",
    );

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      model: string;
      store: boolean;
      temperature?: number;
      reasoning: { effort: string };
      text: { format: { type: string; strict: boolean; name: string } };
    };

    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.store).toBe(false);
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      name: "fletcher_review",
    });
    // SAFETY: the second recorded request is the verification call, sent
    // with the same body shape.
    const verification = requests[1]?.body as typeof body | undefined;

    expect(verification?.text.format.name).toBe("fletcher_verification");
    expect(result.review).toEqual(reviewJson);
    expect(result.usage).toEqual({
      inputTokens: 4000,
      outputTokens: 1000,
      totalTokens: 5000,
      cachedInputTokens: 0,
    });
  });

  it("reports insufficient quota without retrying", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "You exceeded your current quota.",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          }),
          { status: 429 },
        ),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        runReview({ provider: "openai", model: "gpt-6.1-sol", fetch }),
      ),
    );

    expect(fetch.calls()).toBe(1);
    expect(error).toMatchObject({ reason: "quota_exceeded", status: 429 });
  });

  it("reports a model the key can't use", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          provider: "openai",
          model: "gpt-6.1-sol",
          fetch: fakeFetch(
            () =>
              new Response(
                JSON.stringify({
                  error: {
                    message: "The model does not exist.",
                    code: "model_not_found",
                  },
                }),
                { status: 404 },
              ),
          ),
        }),
      ),
    );

    expect(error).toMatchObject({ reason: "model_unavailable" });
  });
});

describe("Reviewer on Anthropic", () => {
  it("asks for schema-constrained JSON with adaptive thinking at the model's effort", async () => {
    const requests: RecordedRequest[] = [];

    const result = await Effect.runPromise(
      runReview({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        fetch: fakeFetch(
          (_, verifying) =>
            anthropicResponse("end_turn", verifying ? keepAll : reviewJson),
          requests,
        ),
      }),
    );

    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("test-api-key");

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      max_tokens: number;
      temperature?: number;
      tool_choice?: unknown;
      tools?: unknown;
      thinking: { type: string };
      output_config: {
        effort: string;
        format: { type: string; schema: { required: string[] } };
      };
    };

    expect(body.max_tokens).toBe(32_000);
    // Claude 5.5+ answers 400 to forced tool use and sampling settings.
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("high");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual([
      "verdict",
      "summary",
      "findings",
    ]);
    // SAFETY: the second recorded request is the verification call, sent
    // with the same body shape.
    const verification = requests[1]?.body as typeof body | undefined;

    expect(verification?.output_config.format.schema.required).toEqual([
      "keep",
      "summary",
    ]);
    expect(result.review).toEqual(reviewJson);
    expect(result.usage.inputTokens).toBe(3600);
    expect(result.usage.outputTokens).toBe(800);
  });

  it("fails as invalid output when Claude refuses or runs out of tokens", async () => {
    for (const stopReason of ["refusal", "max_tokens"]) {
      const error = await Effect.runPromise(
        Effect.flip(
          runReview({
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            fetch: fakeFetch(() => anthropicResponse(stopReason)),
          }),
        ),
      );

      expect(error._tag).toBe("ReviewOutputInvalidError");
      expect(error).toMatchObject({
        detail: `no complete review (stop_reason ${stopReason})`,
      });
    }
  });

  it("reports an empty credit balance as quota, not a bad request", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          fetch: fakeFetch(
            () =>
              new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "invalid_request_error",
                    message:
                      "Your credit balance is too low to access the Anthropic API.",
                  },
                }),
                { status: 400 },
              ),
          ),
        }),
      ),
    );

    expect(error).toMatchObject({ reason: "quota_exceeded" });
  });

  it("keeps the key out of the error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runReview({
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          fetch: fakeFetch(
            () =>
              new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "authentication_error",
                    message: "invalid x-api-key",
                  },
                }),
                { status: 401 },
              ),
          ),
        }),
      ),
    );

    expect(error).toMatchObject({ reason: "key_rejected" });
    expect(JSON.stringify(error)).not.toContain("test-api-key");
    expect(String(error)).not.toContain("test-api-key");
  });
});

describe("golden review schema", () => {
  it("keeps the decoded review shape stable across prompt revisions", () => {
    const decoded = Schema.decodeUnknownSync(GeminiReview)(reviewJson);

    expect(decoded).toEqual(reviewJson);
  });

  it("keeps the persona guardrails in the system prompt", () => {
    expect(FLETCHER_SYSTEM_PROMPT).toContain("never the author");
    expect(FLETCHER_SYSTEM_PROMPT).toContain("concrete, technically correct");
    expect(FLETCHER_SYSTEM_PROMPT).toContain("good_job");
    expect(FLETCHER_SYSTEM_PROMPT).toContain("MEMORY");
    expect(FLETCHER_SYSTEM_PROMPT).toContain("REPOSITORY CONTEXT");
    expect(FLETCHER_SYSTEM_PROMPT).toContain("UNTRUSTED INPUT");
  });
});

describe("buildSystemPrompt", () => {
  it("is the base persona at studio_band intensity and standard tone", () => {
    expect(buildSystemPrompt("studio_band", "standard")).toBe(
      FLETCHER_SYSTEM_PROMPT,
    );
  });

  it("appends the intensity dial for the other settings", () => {
    expect(buildSystemPrompt("sectional", "standard")).toContain(
      "INTENSITY: sectional",
    );
    expect(buildSystemPrompt("carnegie", "standard")).toContain(
      "INTENSITY: Carnegie",
    );
    expect(buildSystemPrompt("carnegie", "standard")).toContain(
      "never fabricated",
    );
  });

  it("swaps in the full Fletcher persona for the ruthless tone", () => {
    const prompt = buildSystemPrompt("studio_band", "ruthless");

    expect(prompt).toBe(FLETCHER_RUTHLESS_SYSTEM_PROMPT);
    expect(prompt).toContain("You are Terence Fletcher");
    expect(prompt).toContain("principal engineer");
    expect(prompt).not.toContain("The persona is seasoning");
  });

  it.each(["standard", "ruthless"] as const)(
    "keeps %s severity tied to evidence rather than repetition",
    (tone) => {
      const prompt = buildSystemPrompt("carnegie", tone);

      expect(prompt).toContain("Severity reflects impact");
      expect(prompt).toContain("Missing context is not evidence of a bug");
      expect(prompt).toContain("workload assumptions");
      expect(prompt).not.toContain("raise the severity one level");
      expect(prompt).not.toContain('"good_job" requires a flawless change');
    },
  );

  it("asks for every real defect and keeps likely ones at lower confidence", () => {
    const prompt = buildSystemPrompt("studio_band", "standard");

    expect(prompt).toContain("Report every distinct real defect, each once.");
    expect(prompt).toContain("Go through every changed file and hunk");
    expect(prompt).toContain("report it with lower confidence");
    expect(prompt).toContain(
      "Drop only\n  suspicions with no concrete trigger.",
    );
    expect(prompt).not.toContain("Prefer a few high-signal findings");
    expect(prompt).not.toContain("Omit unresolved suspicions");
  });

  it("asks finding messages to state the defect before the persona", () => {
    expect(FLETCHER_RUTHLESS_SYSTEM_PROMPT).toContain(
      'Its "message" opens with what\n  is wrong and when it happens',
    );
  });

  it("verifies by removing errors, not uncertainty", () => {
    const prompt = buildVerificationSystemPrompt("studio_band", "standard");

    expect(prompt).toContain("Reject a candidate only when the supplied code");
    expect(prompt).toContain("you are removing errors, not uncertainty");
  });

  it("keeps the rubric and guardrails intact in the ruthless tone", () => {
    const prompt = buildSystemPrompt("studio_band", "ruthless");

    expect(prompt).toContain("never to the person");
    expect(prompt).toContain("never moves them");
    expect(prompt).toContain("never the author");
    expect(prompt).toContain("No profanity and no threats");
    expect(prompt).toContain("Severity honesty");
    expect(prompt).toContain("MEMORY");
  });

  it("makes sectional the quiet Fletcher in the ruthless tone", () => {
    const prompt = buildSystemPrompt("sectional", "ruthless");

    expect(prompt).toContain("The quiet Fletcher");
    expect(prompt).not.toContain("Dial the persona down");
  });

  it("keeps Carnegie's bar in the ruthless tone", () => {
    expect(buildSystemPrompt("carnegie", "ruthless")).toContain(
      "INTENSITY: Carnegie",
    );
  });
});

describe("filterReviewBySeverity", () => {
  const baseFinding = {
    filePath: "src/tempo.ts",
    line: 14,
    category: "correctness",
    confidence: 0.8,
    title: "Off-by-one",
    message: "Guard it.",
  };

  const review: GeminiReview = {
    verdict: "not_my_tempo",
    summary: "Sloppy.",
    findings: [
      { ...baseFinding, severity: "critical" },
      { ...baseFinding, severity: "warning" },
      { ...baseFinding, severity: "suggestion" },
    ],
  };

  it("keeps everything at the suggestion threshold", () => {
    expect(filterReviewBySeverity(review, "suggestion").findings).toHaveLength(
      3,
    );
  });

  it("drops below-threshold findings and derives the verdict from those retained", () => {
    const filtered = filterReviewBySeverity(review, "warning");

    expect(filtered.findings.map((finding) => finding.severity)).toEqual([
      "critical",
      "warning",
    ]);
    expect(filtered.verdict).toBe("not_my_tempo");

    expect(filterReviewBySeverity(review, "critical").findings).toHaveLength(1);
  });

  it("keeps the model's summary while any finding remains", () => {
    expect(filterReviewBySeverity(review, "critical").summary).toBe("Sloppy.");
  });
});

describe("buildReviewUserPrompt", () => {
  it("omits the previous review section without prior findings", () => {
    expect(buildReviewUserPrompt(input)).not.toContain("Previous review");
  });

  it("lists prior findings with their locations when provided", () => {
    const prompt = buildReviewUserPrompt({
      ...input,
      priorReview: {
        headSha: "old456",
        findings: [
          {
            filePath: "src/tempo.ts",
            line: 14,
            severity: "warning",
            title: "Off-by-one in beat subdivision",
            message: "Guard subdivision before multiplying.",
          },
          {
            filePath: "src/cymbal.ts",
            line: null,
            severity: "suggestion",
            title: null,
            message: "Name the constant.",
          },
        ],
      },
    });

    expect(prompt).toContain("Previous review (commit old456)");
    expect(prompt).toContain(
      "- src/tempo.ts:14 [warning] Off-by-one in beat subdivision \u2014 " +
        "Guard subdivision before multiplying.",
    );
    expect(prompt).toContain("- src/cymbal.ts [suggestion] Name the constant.");
  });

  it("tells the model when the previous review was clean", () => {
    const prompt = buildReviewUserPrompt({
      ...input,
      priorReview: { headSha: "old456", findings: [] },
    });

    expect(prompt).toContain("Previous review (commit old456): no findings");
  });

  it("omits repository context sections without context", () => {
    const prompt = buildReviewUserPrompt(input);

    expect(prompt).not.toContain("Repository guidelines");
    expect(prompt).not.toContain("<file");
  });

  it("orders repository material, then the pull request, then the diff", () => {
    const prompt = buildReviewUserPrompt({
      ...input,
      context: {
        guidelinesRef: "main",
        guidelines: [
          {
            path: "AGENTS.md",
            content: "Use import type for types.",
            truncated: false,
          },
        ],
        manifests: [
          {
            path: "package.json",
            content: '{"dependencies":{"effect":"3.22.2"}}',
            truncated: false,
          },
        ],
        files: [
          {
            path: "src/tempo.ts",
            content: "export const tempo = 240;",
            truncated: true,
          },
        ],
        omittedFiles: ["src/huge.ts"],
      },
    });

    expect(prompt).toContain(
      'Repository guidelines (from main):\n<guideline path="AGENTS.md">\n' +
        "Use import type for types.\n</guideline>",
    );
    expect(prompt).toContain('<manifest path="package.json">');
    expect(prompt).toContain('<file path="src/tempo.ts" truncated="true">');
    expect(prompt).toContain("- src/huge.ts");
    // Repository-wide material leads so reviews share a cacheable prefix.
    expect(prompt.indexOf("<guideline")).toBeLessThan(
      prompt.indexOf("Pull request: #42"),
    );
    expect(prompt.indexOf("<manifest")).toBeLessThan(
      prompt.indexOf("Pull request: #42"),
    );
    expect(prompt.indexOf("Pull request: #42")).toBeLessThan(
      prompt.indexOf("<file"),
    );
    expect(prompt.indexOf("<file")).toBeLessThan(
      prompt.indexOf("Unified diff:"),
    );
  });
});

describe("candidate verification", () => {
  const critical = {
    ...reviewJson.findings[0]!,
    title: "Unsupported allegation",
    severity: "critical",
  };

  const twoCandidates = {
    ...reviewJson,
    verdict: "not_my_tempo",
    findings: [...reviewJson.findings, critical],
  };

  const verifyWith =
    (verification: ReviewPayload, candidates: ReviewPayload = reviewJson) =>
    (_: number, verifying: boolean) =>
      geminiResponse(verifying ? verification : candidates);

  it("verifies numbered candidates in persona against the same context", async () => {
    const requests: RecordedRequest[] = [];

    await Effect.runPromise(
      runReview({ fetch: fakeFetch(verifyWith(keepAll), requests) }),
    );

    expect(requests).toHaveLength(2);

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[1]?.body as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
      generationConfig: { responseSchema: { required: string[] } };
    };

    const system = body.systemInstruction.parts[0]?.text ?? "";
    const user = body.contents[0]?.parts[0]?.text ?? "";

    expect(system.startsWith(FLETCHER_SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain("CANDIDATE VERIFICATION");
    expect(user.startsWith(buildReviewUserPrompt(input))).toBe(true);
    expect(user).toContain(`0: ${JSON.stringify(reviewJson.findings[0])}`);
    expect(body.generationConfig.responseSchema.required).toEqual([
      "keep",
      "summary",
    ]);
  });

  it("skips verification when there are no candidates", async () => {
    const fetch = fakeFetch(() =>
      geminiResponse({ ...reviewJson, findings: [] }),
    );

    const result = await Effect.runPromise(runReview({ fetch }));

    expect(fetch.calls()).toBe(1);
    expect(result.review.verdict).toBe("good_job");
    expect(result.usage.totalTokens).toBe(1500);
    expect(result.verification).toEqual({ status: "not_needed" });
  });

  it("keeps the candidates' summary when every candidate survives", async () => {
    const result = await Effect.runPromise(
      runReview({ fetch: fakeFetch(verifyWith(keepAll)) }),
    );

    expect(result.review).toEqual(reviewJson);
    expect(result.usage.totalTokens).toBe(3000);
    expect(result.verification).toEqual({
      status: "verified",
      candidates: 1,
      kept: 1,
    });
  });

  it("publishes the kept subset unchanged with the verifier's summary", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch(
          verifyWith({ keep: [0], summary: "One real defect." }, twoCandidates),
        ),
      }),
    );

    expect(result.review).toEqual({
      verdict: "almost",
      summary: "One real defect.",
      findings: reviewJson.findings,
    });
    expect(result.verification).toEqual({
      status: "verified",
      candidates: 2,
      kept: 1,
    });
  });

  it("clears the verdict when no candidate survives", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch(
          verifyWith({ keep: [], summary: "Nothing survived scrutiny." }),
        ),
      }),
    );

    expect(result.review).toEqual({
      verdict: "good_job",
      summary: "Nothing survived scrutiny.",
      findings: [],
    });
  });

  it("keeps candidates once each, in their original order", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch(
          verifyWith({ keep: [1, 0, 1], summary: "Both." }, twoCandidates),
        ),
      }),
    );

    expect(result.review.findings).toEqual(twoCandidates.findings);
    expect(result.review.summary).toBe(twoCandidates.summary);
  });

  it.each([
    ["an invalid reply", { verdict: "invalid" }],
    ["an unknown index", { keep: [0, 3], summary: "Phantom." }],
  ] as const)(
    "publishes the candidates unverified after %s",
    async (_, verification) => {
      const fetch = fakeFetch(verifyWith(verification));

      const result = await Effect.runPromise(runReview({ fetch }));

      expect(fetch.calls()).toBe(2);
      expect(result.review).toEqual(reviewJson);
      expect(result.usage.totalTokens).toBe(1500);
      expect(result.verification).toEqual({
        status: "unverified",
        candidates: 1,
        reason: "ReviewOutputInvalidError",
      });
    },
  );

  it("publishes the candidates unverified when verification times out", async () => {
    const fetch = fakeFetch((_, verifying) =>
      verifying ? new Promise<Response>(() => {}) : geminiResponse(),
    );

    const result = await Effect.runPromise(
      runReview({ fetch, verificationTimeoutMillis: 50 }),
    );

    expect(fetch.calls()).toBe(2);
    expect(result.review).toEqual(reviewJson);
    expect(result.verification).toMatchObject({
      status: "unverified",
      reason: "ReviewTimeoutError",
    });
  });

  it("gives the candidates their own timeout, apart from verification", async () => {
    const fetch = fakeFetch(() => new Promise<Response>(() => {}));

    const error = await Effect.runPromise(
      Effect.flip(
        runReview({ fetch, timeoutMillis: 50, verificationTimeoutMillis: 1 }),
      ),
    );

    expect(error._tag).toBe("ReviewTimeoutError");
    expect(error).toMatchObject({ timeoutMillis: 50 });
    expect(fetch.calls()).toBe(1);
  });

  it("retries verification without generating candidates again", async () => {
    const requests: RecordedRequest[] = [];

    const fetch = fakeFetch(
      (call, verifying) =>
        call === 2
          ? new Response("overloaded", { status: 503 })
          : geminiResponse(verifying ? keepAll : reviewJson),
      requests,
    );

    const result = await Effect.runPromise(runReview({ fetch }));

    expect(fetch.calls()).toBe(3);
    expect(requests[2]?.body).toEqual(requests[1]?.body);
    expect(result.verification).toMatchObject({ status: "verified" });
    expect(result.usage.totalTokens).toBe(3000);
  });

  it("keeps combined usage unknown when one stage omits it", async () => {
    const result = await Effect.runPromise(
      runReview({
        fetch: fakeFetch((_, verifying) =>
          verifying
            ? geminiResponse(keepAll, null)
            : geminiResponse(reviewJson, geminiUsage),
        ),
      }),
    );

    expect(result.usage.totalTokens).toBeNull();
    expect(result.usage.inputTokens).toBeNull();
  });
});

describe("filtered review assessment", () => {
  it("removes stale allegations when the threshold hides all findings", () => {
    const review = Schema.decodeUnknownSync(GeminiReview)(reviewJson);
    const filtered = filterReviewBySeverity(review, "critical");

    expect(filtered.findings).toEqual([]);
    expect(filtered.verdict).toBe("good_job");
    expect(filtered.summary).toBe(
      "No findings remain at the configured severity threshold.",
    );
  });
});

describe("specialist review", () => {
  const finding = (title: string, severity = "warning") => ({
    ...reviewJson.findings[0]!,
    title,
    severity,
  });

  const logic = finding("Off-by-one in beat subdivision");
  const race = finding("Tempo cache mutated across requests", "critical");
  const vacuous = finding("Patched sleep makes the count-off test vacuous");

  type Focus =
    | "logic"
    | "reliability"
    | "concurrency"
    | "security"
    | "tests_contracts";

  // Each focus is found by the opening words of its section of the prompt.
  const focusOf = (body: string): Focus =>
    body.includes("Failure handling")
      ? "reliability"
      : body.includes("Concurrency and lifetime")
        ? "concurrency"
        : body.includes("Security at trust boundaries")
          ? "security"
          : body.includes("Tests and contracts")
            ? "tests_contracts"
            : "logic";

  // Each pass answers by its focus; the merge answers with `merge`.
  const specialists =
    (
      merge: ReviewPayload | Response,
      byFocus: Partial<Record<Focus, ReviewPayload | Response>> = {},
    ) =>
    (_: number, __: boolean, body: string) => {
      const reply = (payload: ReviewPayload | Response) =>
        payload instanceof Response ? payload : geminiResponse(payload);

      if (body.includes("MERGING SPECIALIST FINDINGS")) {
        return reply(merge);
      }

      const focus = focusOf(body);

      const defaults = {
        logic: { ...reviewJson, findings: [logic] },
        reliability: { ...reviewJson, findings: [] },
        concurrency: { ...reviewJson, findings: [race, logic] },
        security: { ...reviewJson, findings: [] },
        tests_contracts: { ...reviewJson, findings: [vacuous] },
      } satisfies Record<Focus, ReviewPayload>;

      return reply(byFocus[focus] ?? defaults[focus]);
    };

  const runSpecialists = (fetch: ReturnType<typeof fakeFetch>) =>
    runReview({ fetch, strategy: "specialists" });

  it("runs one pass per focus on a shared prompt prefix", async () => {
    const requests: RecordedRequest[] = [];

    await Effect.runPromise(
      runSpecialists(
        fakeFetch(
          specialists({ keep: [0, 1, 3], summary: "Merged." }),
          requests,
        ),
      ),
    );

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.
    const bodies = requests.map(
      (request) =>
        request.body as {
          systemInstruction: { parts: { text: string }[] };
          contents: { parts: { text: string }[] }[];
        },
    );

    const passes = bodies.slice(0, 5);

    expect(requests).toHaveLength(6);

    for (const body of passes) {
      expect(body.systemInstruction.parts[0]?.text).toBe(
        FLETCHER_SYSTEM_PROMPT,
      );
      expect(
        body.contents[0]?.parts[0]?.text.startsWith(
          buildReviewUserPrompt(input),
        ),
      ).toBe(true);
    }

    expect(
      new Set(passes.map((body) => body.contents[0]?.parts[0]?.text)).size,
    ).toBe(5);

    const merge = bodies[5]?.contents[0]?.parts[0]?.text ?? "";

    expect(merge).not.toContain(input.diff);
    expect(merge).toContain(`3: ${JSON.stringify(vacuous)}`);
  });

  it("publishes one finding per defect in the merge's order", async () => {
    const result = await Effect.runPromise(
      runSpecialists(
        fakeFetch(specialists({ keep: [1, 0, 3, 1], summary: "Merged." })),
      ),
    );

    expect(result.review).toEqual({
      verdict: "not_my_tempo",
      summary: "Merged.",
      findings: [race, logic, vacuous],
    });
    expect(result.fanOut).toEqual({
      passes: 5,
      failedPasses: 0,
      candidates: 4,
      kept: 3,
      merge: "merged",
    });
    expect(result.verification).toBeUndefined();
    expect(result.usage.totalTokens).toBe(9000);
  });

  it("removes exact duplicates when the merge fails", async () => {
    const result = await Effect.runPromise(
      runSpecialists(fakeFetch(specialists({ verdict: "invalid" }))),
    );

    expect(result.review.findings).toEqual([logic, race, vacuous]);
    expect(result.fanOut).toMatchObject({ kept: 3, merge: "unmerged" });
    expect(result.usage.totalTokens).toBe(7500);
  });

  it("keeps the other passes' findings when one pass fails", async () => {
    const result = await Effect.runPromise(
      runSpecialists(
        fakeFetch(
          specialists(
            { keep: [0, 1], summary: "Merged." },
            { concurrency: new Response("bad request", { status: 400 }) },
          ),
        ),
      ),
    );

    expect(result.review.findings).toEqual([logic, vacuous]);
    expect(result.fanOut).toMatchObject({ failedPasses: 1, candidates: 2 });
  });

  it("gives up on a pass past its deadline and keeps the others", async () => {
    const result = await Effect.runPromise(
      runReview({
        strategy: "specialists",
        passDeadlineMillis: 50,
        fetch: fakeFetch(
          specialists(
            { keep: [0, 1], summary: "Merged." },
            { concurrency: new Response("slow", { status: 503 }) },
          ),
        ),
        // The overloaded pass keeps retrying until its deadline ends it.
        maxRetries: 100,
        retryBaseMillis: 20,
      }),
    );

    expect(result.review.findings).toEqual([logic, vacuous]);
    expect(result.fanOut).toMatchObject({ failedPasses: 1, candidates: 2 });
  });

  it("fails only when every pass fails", async () => {
    const fetch = fakeFetch(() => new Response("bad request", { status: 400 }));

    const error = await Effect.runPromise(Effect.flip(runSpecialists(fetch)));

    expect(error._tag).toBe("ReviewProviderError");
    expect(fetch.calls()).toBe(5);
  });

  it("skips the merge with at most one candidate", async () => {
    const empty = { ...reviewJson, findings: [] };

    const fetch = fakeFetch(
      specialists(
        { keep: [], summary: "unused" },
        { concurrency: empty, tests_contracts: empty },
      ),
    );

    const result = await Effect.runPromise(runSpecialists(fetch));

    expect(fetch.calls()).toBe(5);
    expect(result.review.findings).toEqual([logic]);
    expect(result.fanOut).toMatchObject({ merge: "not_needed", kept: 1 });
  });
});

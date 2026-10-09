import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
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

type ReviewPayload = typeof reviewJson | { readonly verdict: string };

const geminiUsage = {
  promptTokenCount: 1200,
  candidatesTokenCount: 300,
  totalTokenCount: 1500,
};

const geminiResponse = (
  review: ReviewPayload = reviewJson,
  usageMetadata: typeof geminiUsage | null = geminiUsage,
) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify(review) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: usageMetadata ?? undefined,
    }),
    { headers: { "content-type": "application/json" } },
  );

const openAiResponse = () =>
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
              text: JSON.stringify(reviewJson),
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

const anthropicResponse = () =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "fletcher_review",
          input: reviewJson,
        },
      ],
      stop_reason: "tool_use",
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

// Answers every provider call locally, recording what was sent.
const fakeFetch = (
  answer: (call: number) => Response | Promise<Response>,
  requests: RecordedRequest[] = [],
) => {
  let calls = 0;

  const fetchImpl: typeof fetch = async (url, init) => {
    calls += 1;
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });

    return answer(calls);
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
      "https://gemini.test/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("test-api-key");

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
      generationConfig: {
        responseMimeType: string;
        responseSchema: { required: string[] };
        temperature: number;
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
    expect(body.generationConfig.temperature).toBe(0.2);
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
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
    ]);
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("test-api-key");
  });

  it("decodes the reply into a review with usage", async () => {
    const result = await Effect.runPromise(
      runReview({ fetch: fakeFetch(() => geminiResponse()) }),
    );

    expect(result.review).toEqual(reviewJson);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
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
    });
  });

  it("retries rate limits and succeeds on a later attempt", async () => {
    const fetch = fakeFetch((call) =>
      call === 1
        ? new Response("slow down", { status: 429 })
        : geminiResponse(),
    );

    const result = await Effect.runPromise(runReview({ fetch }));

    expect(fetch.calls()).toBe(2);
    expect(result.review.verdict).toBe("almost");
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
  it("sends a strict JSON-schema Responses request without sampling settings", async () => {
    const requests: RecordedRequest[] = [];

    const result = await Effect.runPromise(
      runReview({
        provider: "openai",
        model: "gpt-6.1-sol",
        fetch: fakeFetch(() => openAiResponse(), requests),
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
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      name: "fletcher_review",
    });
    expect(result.review).toEqual(reviewJson);
    expect(result.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
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
  it("forces the review tool with a large output budget", async () => {
    const requests: RecordedRequest[] = [];

    const result = await Effect.runPromise(
      runReview({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        fetch: fakeFetch(() => anthropicResponse(), requests),
      }),
    );

    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("test-api-key");

    // SAFETY: fakeFetch recorded the JSON body Fletcher sent.

    const body = requests[0]?.body as {
      max_tokens: number;
      temperature: number;
      tool_choice: { type: string; name: string };
      tools: { name: string }[];
    };

    expect(body.max_tokens).toBe(16_000);
    expect(body.temperature).toBe(0.2);
    expect(body.tool_choice).toMatchObject({
      type: "tool",
      name: "fletcher_review",
    });
    expect(result.review).toEqual(reviewJson);
    expect(result.usage.inputTokens).toBe(1800);
    expect(result.usage.outputTokens).toBe(400);
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

  it("drops below-threshold findings without touching the verdict", () => {
    const filtered = filterReviewBySeverity(review, "warning");

    expect(filtered.findings.map((finding) => finding.severity)).toEqual([
      "critical",
      "warning",
    ]);
    expect(filtered.verdict).toBe("not_my_tempo");

    expect(filterReviewBySeverity(review, "critical").findings).toHaveLength(1);
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
});

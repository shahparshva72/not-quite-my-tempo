import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
  filterReviewBySeverity,
  FLETCHER_RUTHLESS_SYSTEM_PROMPT,
  FLETCHER_SYSTEM_PROMPT,
  GeminiReview,
  GeminiReviewer,
  GeminiReviewerLive,
  geminiResponseJsonSchema,
} from "@not-quite-my-tempo/gemini";
import type {
  GeminiReviewerConfig,
  GeminiReviewInput,
} from "@not-quite-my-tempo/gemini";

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

const candidates = [
  {
    content: { parts: [{ text: JSON.stringify(reviewJson) }] },
  },
];

const usageMetadata = {
  promptTokenCount: 1200,
  candidatesTokenCount: 300,
  totalTokenCount: 1500,
};

const successResponse = () =>
  new Response(JSON.stringify({ candidates, usageMetadata }));

const successResponseWithoutUsage = () =>
  new Response(JSON.stringify({ candidates }));

const runReview = (config: Omit<GeminiReviewerConfig, "apiKey">) =>
  Effect.gen(function* () {
    const reviewer = yield* GeminiReviewer;

    return yield* reviewer.review(input);
  }).pipe(
    Effect.provide(
      GeminiReviewerLive({
        apiKey: "test-api-key",
        retryBaseMillis: 1,
        ...config,
      }),
    ),
  );

describe("GeminiReviewer.review", () => {
  it("sends a structured-output request to the configured model", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (url, init) => {
      requests.push({ url: String(url), init });

      return Promise.resolve(successResponse());
    };

    const result = await Effect.runPromise(
      runReview({ baseUrl: "https://gemini.test", fetchImpl }),
    );

    expect(result.model).toBe("gemini-3.8-flash");
    expect(requests[0]?.url).toBe(
      "https://gemini.test/v1beta/models/gemini-3.8-flash:generateContent",
    );

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("test-api-key");

    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.systemInstruction.parts[0].text).toBe(FLETCHER_SYSTEM_PROMPT);
    expect(body.contents[0].parts[0].text).toBe(buildReviewUserPrompt(input));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(
      geminiResponseJsonSchema,
    );
  });

  it("sends Vertex AI keys to Vertex AI's express endpoint", async () => {
    const urls: string[] = [];

    const fetchImpl: typeof fetch = (url, init) => {
      urls.push(String(url));
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
        "test-api-key",
      );

      return Promise.resolve(successResponse());
    };

    await Effect.runPromise(
      runReview({ provider: "vertex_express", fetchImpl }),
    );

    expect(urls).toEqual([
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
    ]);
  });

  it("decodes the candidate JSON into a review with usage metadata", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(successResponse());

    const result = await Effect.runPromise(runReview({ fetchImpl }));

    expect(result.review).toEqual(reviewJson);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
    });
  });

  it("returns null usage when the response omits usage metadata", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(successResponseWithoutUsage());

    const result = await Effect.runPromise(runReview({ fetchImpl }));

    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("retries retryable statuses and succeeds on a later attempt", async () => {
    let calls = 0;

    const fetchImpl: typeof fetch = () => {
      calls += 1;

      return Promise.resolve(
        calls === 1
          ? new Response("slow down", { status: 429 })
          : successResponse(),
      );
    };

    const result = await Effect.runPromise(runReview({ fetchImpl }));

    expect(calls).toBe(2);
    expect(result.review.verdict).toBe("almost");
  });

  it("does not retry client errors", async () => {
    let calls = 0;

    const fetchImpl: typeof fetch = () => {
      calls += 1;

      return Promise.resolve(new Response("bad request", { status: 400 }));
    };

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetchImpl })),
    );

    expect(calls).toBe(1);
    expect(error._tag).toBe("GeminiResponseError");
    expect(error).toMatchObject({ status: 400, body: "bad request" });
  });

  it("gives up after exhausting retries", async () => {
    let calls = 0;

    const fetchImpl: typeof fetch = () => {
      calls += 1;

      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetchImpl, maxRetries: 2 })),
    );

    expect(calls).toBe(3);
    expect(error._tag).toBe("GeminiResponseError");
  });

  it("fails with a parse error when the candidate is not a valid review", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: '{"verdict":"loud"}' }] } },
            ],
          }),
        ),
      );

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetchImpl })),
    );

    expect(error._tag).toBe("GeminiResponseParseError");
  });

  it("fails with a timeout error when the request hangs", async () => {
    const fetchImpl: typeof fetch = () =>
      new Promise<Response>(() => {
        // Never resolves; the reviewer's timeout must fire.
      });

    const error = await Effect.runPromise(
      Effect.flip(runReview({ fetchImpl, timeoutMillis: 20, maxRetries: 0 })),
    );

    expect(error._tag).toBe("GeminiTimeoutError");
    expect(error).toMatchObject({ timeoutMillis: 20 });
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

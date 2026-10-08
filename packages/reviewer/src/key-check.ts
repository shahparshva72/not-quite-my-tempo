import { Data, Effect, Option } from "effect";

import type { GeminiProvider } from "./catalog.js";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_BASE_URL,
  VERTEX_API_BASE_URL,
} from "./reviewer.js";

/** Neither Google API accepted the key, and at least one couldn't answer. */
export class GeminiKeyCheckError extends Data.TaggedError(
  "GeminiKeyCheckError",
)<{
  readonly cause: string;
}> {}

export interface GeminiKeyCheckConfig {
  readonly geminiBaseUrl?: string;
  readonly vertexBaseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

type Answer = "accepted" | "rejected" | "unavailable";

// 400/401/403/404: this API doesn't accept the key (wrong key, or a key
// restricted to the other API). Anything else non-2xx: couldn't tell.
const answerFor = (status: number): Answer =>
  status >= 200 && status < 300
    ? "accepted"
    : [400, 401, 403, 404].includes(status)
      ? "rejected"
      : "unavailable";

/**
 * Which Google API accepts a key, using only free calls: the Gemini
 * Developer API's model list, then Vertex AI express mode's countTokens.
 * None means both rejected it. Fails with GeminiKeyCheckError when neither
 * accepted it and at least one couldn't answer, so a caller never stores a
 * key it couldn't verify.
 */
export const checkGeminiKey = (
  apiKey: string,
  config: GeminiKeyCheckConfig = {},
) =>
  Effect.gen(function* () {
    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));

    const ask = (url: string, init: RequestInit) =>
      Effect.tryPromise({
        try: () => fetchImpl(url, init),
        catch: () => "unavailable" as const,
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.map((response) => answerFor(response.status)),
        Effect.orElseSucceed((): Answer => "unavailable"),
      );

    const gemini = yield* ask(
      `${config.geminiBaseUrl ?? GEMINI_API_BASE_URL}/v1beta/models?pageSize=1`,
      { method: "GET", headers: { "x-goog-api-key": apiKey } },
    );

    if (gemini === "accepted") {
      return Option.some<GeminiProvider>("gemini_api");
    }

    const vertex = yield* ask(
      `${config.vertexBaseUrl ?? VERTEX_API_BASE_URL}/v1/publishers/google/models/${config.model ?? DEFAULT_GEMINI_MODEL}:countTokens`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ok" }] }],
        }),
      },
    );

    if (vertex === "accepted") {
      return Option.some<GeminiProvider>("vertex_express");
    }

    if (gemini === "unavailable" || vertex === "unavailable") {
      return yield* new GeminiKeyCheckError({
        cause: `Gemini API ${gemini}, Vertex AI ${vertex}`,
      });
    }

    return Option.none<GeminiProvider>();
  });

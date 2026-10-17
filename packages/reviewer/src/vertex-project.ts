import { Effect, Option } from "effect";

import { VERTEX_API_BASE_URL } from "./reviewer.js";

export interface VertexProjectConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

// A model ID that never exists, so the call can only answer with the 404.
const PROBE_MODEL = "fletcher-project-probe";

const PROJECT_IN_MESSAGE = /projects\/([a-z0-9-]+)\/locations\//;

/**
 * The Google Cloud project behind a Vertex AI express key. Express mode
 * routes its short URLs to us-central1, where some models (Gemini 4 Argon)
 * aren't served; the global location serves them but its URL names the
 * project, which express mode never states. Its 404 for an unknown model
 * does ("Publisher model `projects/123/locations/us-central1/...` was not
 * found"), so one free countTokens call reveals it. None when the answer
 * doesn't name a project, so callers keep the short URL.
 */
export const detectVertexProject = (
  apiKey: string,
  config: VertexProjectConfig = {},
) => {
  const fetchImpl =
    config.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));

  return Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(
        `${config.baseUrl ?? VERTEX_API_BASE_URL}/v1/publishers/google/models/${PROBE_MODEL}:countTokens`,
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

      return response.text();
    },
    catch: () => Option.none<string>(),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.map((body) =>
      Option.fromNullable(PROJECT_IN_MESSAGE.exec(body)?.[1]),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

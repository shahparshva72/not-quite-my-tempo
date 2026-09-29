import { Effect } from "effect";

import { GEMINI_API_BASE_URL, GeminiRequestError } from "./reviewer.js";

export interface GeminiKeyCheckConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Whether Gemini accepts an API key, using the free model-list call.
 * 400/401/403 mean the key is wrong or lacks access (false); any other
 * failure means Gemini couldn't answer and is a GeminiRequestError, so a
 * caller never stores a key it couldn't verify.
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

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `${config.baseUrl ?? GEMINI_API_BASE_URL}/v1beta/models?pageSize=1`,
          { method: "GET", headers: { "x-goog-api-key": apiKey } },
        ),
      catch: (cause) => new GeminiRequestError({ cause }),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag(
        "TimeoutException",
        (cause) => new GeminiRequestError({ cause }),
      ),
    );

    if (response.ok) {
      return true;
    }

    if ([400, 401, 403].includes(response.status)) {
      return false;
    }

    return yield* new GeminiRequestError({
      cause: `Gemini answered ${response.status}`,
    });
  });

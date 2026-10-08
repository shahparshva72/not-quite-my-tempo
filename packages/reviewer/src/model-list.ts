import { Data, Effect, Match, Option, Schema } from "effect";

import { isSupportedGeneration, MODEL_CATALOG, vendorOf } from "./catalog.js";
import type { ReviewProvider } from "./catalog.js";
import {
  ANTHROPIC_API_BASE_URL,
  GEMINI_API_BASE_URL,
  OPENAI_API_BASE_URL,
} from "./reviewer.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** The provider didn't answer the model list, so nothing can be decided. */
export class ModelListUnavailableError extends Data.TaggedError(
  "ModelListUnavailableError",
)<{
  readonly provider: ReviewProvider;
  readonly status: number | null;
}> {}

export interface ModelListConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

// OpenAI's list mixes in embedding, audio, image, and moderation models.
const NOT_A_CHAT_MODEL =
  /embedding|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search/;

const IdList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const GeminiModelList = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      supportedGenerationMethods: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const catalogOrder = (id: string) => {
  const index = MODEL_CATALOG.findIndex((model) => model.id === id);

  return index === -1 ? MODEL_CATALOG.length : index;
};

/** Supported models first in catalog order, then the rest by name. */
const sortModels = (ids: readonly string[]) =>
  [...new Set(ids)].sort(
    (left, right) =>
      catalogOrder(left) - catalogOrder(right) || left.localeCompare(right),
  );

const listRequest = (
  provider: ReviewProvider,
  apiKey: string,
  baseUrl: string | undefined,
) =>
  Match.value(provider).pipe(
    Match.when("openai", () => ({
      url: `${baseUrl ?? OPENAI_API_BASE_URL}/v1/models`,
      headers: { authorization: `Bearer ${apiKey}` },
    })),
    Match.when("anthropic", () => ({
      url: `${baseUrl ?? ANTHROPIC_API_BASE_URL}/v1/models?limit=1000`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    })),
    Match.orElse(() => ({
      url: `${baseUrl ?? GEMINI_API_BASE_URL}/v1beta/models?pageSize=1000`,
      headers: { "x-goog-api-key": apiKey },
    })),
  );

const modelIds = (provider: ReviewProvider, body: string) =>
  Match.value(provider).pipe(
    Match.when("gemini_api", () =>
      Schema.decodeUnknown(Schema.parseJson(GeminiModelList))(body).pipe(
        Effect.map((list) =>
          list.models.flatMap((model) =>
            model.supportedGenerationMethods?.includes("generateContent") ===
            false
              ? []
              : [model.name.replace(/^models\//, "")],
          ),
        ),
      ),
    ),
    Match.orElse(() =>
      Schema.decodeUnknown(Schema.parseJson(IdList))(body).pipe(
        Effect.map((list) => list.data.map((model) => model.id)),
      ),
    ),
  );

/**
 * The supported models a key can use, from the provider's free model list
 * (no tokens spent). None means the provider rejected the key. Vertex AI
 * express mode has no list, so its options are the catalog's Gemini models.
 */
export const listReviewModels = (
  provider: ReviewProvider,
  apiKey: string,
  config: ModelListConfig = {},
): Effect.Effect<
  Option.Option<readonly string[]>,
  ModelListUnavailableError
> => {
  const vendor = vendorOf(provider);

  if (provider === "vertex_express") {
    return Effect.succeed(
      Option.some(
        MODEL_CATALOG.flatMap((model) =>
          model.vendor === "google" ? [model.id] : [],
        ),
      ),
    );
  }

  const request = listRequest(provider, apiKey, config.baseUrl);

  const fetchImpl =
    config.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));

  const unavailable = (status: number | null) =>
    new ModelListUnavailableError({ provider, status });

  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(request.url, { headers: request.headers }),
      catch: () => unavailable(null),
    }).pipe(
      Effect.timeoutFail({
        duration: "10 seconds",
        onTimeout: () => unavailable(null),
      }),
    );

    if ([400, 401, 403, 404].includes(response.status)) {
      return Option.none();
    }

    if (!response.ok) {
      return yield* unavailable(response.status);
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => unavailable(response.status),
    });

    const ids = yield* modelIds(provider, body).pipe(
      Effect.mapError(() => unavailable(response.status)),
    );

    return Option.some(
      sortModels(
        ids.filter(
          (id) =>
            isSupportedGeneration(vendor, id) && !NOT_A_CHAT_MODEL.test(id),
        ),
      ),
    );
  });
};

import { Match } from "effect";

/**
 * Which API a review key works with. Gemini keys come in two flavours
 * (Google AI Studio and Vertex AI express mode) that share a request body;
 * OpenAI and Anthropic keys each have their own API.
 */
export type ReviewProvider =
  | "gemini_api"
  | "vertex_express"
  | "openai"
  | "anthropic";

/** The two Google APIs a Gemini key can work with. */
export type GeminiProvider = Extract<
  ReviewProvider,
  "gemini_api" | "vertex_express"
>;

/** The company whose models a provider serves. */
export type ModelVendor = "google" | "openai" | "anthropic";

export const vendorOf = (provider: ReviewProvider): ModelVendor =>
  Match.value(provider).pipe(
    Match.when("openai", (): ModelVendor => "openai"),
    Match.when("anthropic", (): ModelVendor => "anthropic"),
    Match.orElse((): ModelVendor => "google"),
  );

/**
 * Credit tiers on the paid plan (docs/MULTI_PROVIDER_BYOK_DESIGN.md, "Paid
 * plan credits"). "excluded" models are too expensive for the plan and
 * only run on a workspace's own key.
 */
export type ModelTier = "lite" | "standard" | "pro" | "excluded";

export interface CatalogModel {
  readonly vendor: ModelVendor;
  readonly id: string;
  readonly tier: ModelTier;
  /** Credits per typical review; null when excluded from the plan. */
  readonly weight: number | null;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  /** Reasoning models reject sampling settings such as temperature. */
  readonly reasoning: boolean;
}

/** When the prices below were copied from models.dev (cross-checked on OpenRouter). */
export const MODEL_PRICES_FETCHED_AT = "2026-10-08";

/** The paid plan's model when an admin hasn't picked one. */
export const DEFAULT_PLAN_CATALOG_MODEL: CatalogModel = {
  vendor: "google",
  id: "gemini-3.8-flash",
  tier: "standard",
  weight: 1,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  reasoning: false,
};

/**
 * Models Fletcher supports: GPT-5.6+, Claude 5.5+, and Gemini 3.5+. Tiers
 * are reviewed by hand against docs/MODEL_PRICING.md. Order within a
 * vendor is most to least expensive, which is also the downgrade order.
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  // OpenAI
  {
    vendor: "openai",
    id: "gpt-6-astra",
    tier: "excluded",
    weight: null,
    inputUsdPerMillion: 10,
    outputUsdPerMillion: 50,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-5.6",
    tier: "excluded",
    weight: null,
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-5.6-sol",
    tier: "excluded",
    weight: null,
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-5.6-terra",
    tier: "pro",
    weight: 3,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 12,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-6.1-sol",
    tier: "pro",
    weight: 3,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-6-sol",
    tier: "pro",
    weight: 3,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-5.6-luna",
    tier: "lite",
    weight: 0.5,
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
    reasoning: true,
  },
  {
    vendor: "openai",
    id: "gpt-6-luna",
    tier: "lite",
    weight: 0.5,
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    reasoning: true,
  },
  // Anthropic. Claude Haiku 5.5 joins once its price is published.
  {
    vendor: "anthropic",
    id: "claude-opus-5-5",
    tier: "excluded",
    weight: null,
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    reasoning: false,
  },
  {
    vendor: "anthropic",
    id: "claude-sonnet-5-5",
    tier: "pro",
    weight: 3,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    reasoning: false,
  },
  // Google
  {
    vendor: "google",
    id: "gemini-3.5-flash",
    tier: "pro",
    weight: 3,
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 9,
    reasoning: false,
  },
  DEFAULT_PLAN_CATALOG_MODEL,
  {
    vendor: "google",
    id: "gemini-3.7-flash",
    tier: "standard",
    weight: 1,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    reasoning: false,
  },
  {
    vendor: "google",
    id: "gemini-3.6-flash",
    tier: "standard",
    weight: 1,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    reasoning: false,
  },
  {
    vendor: "google",
    id: "gemini-3.5-flash-lite",
    tier: "lite",
    weight: 0.5,
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    reasoning: false,
  },
];

/** Recommended model per vendor, preselected in the model pickers. */
export const DEFAULT_MODELS: Readonly<Record<ModelVendor, string>> = {
  google: "gemini-3.8-flash",
  openai: "gpt-6.1-sol",
  anthropic: "claude-sonnet-5-5",
};

export const DEFAULT_PLAN_MODEL = DEFAULT_PLAN_CATALOG_MODEL.id;

export const findCatalogModel = (id: string): CatalogModel | undefined =>
  MODEL_CATALOG.find((model) => model.id === id);

const GENERATION = {
  openai: { pattern: /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/, minimum: [5, 6] },
  anthropic: {
    pattern: /^claude-[a-z]+-(\d+)(?:-(\d+))?(?:-|$)/,
    minimum: [5, 5],
  },
  google: { pattern: /^gemini-(\d+)\.(\d+)(?:-|$)/, minimum: [3, 5] },
} as const;

/**
 * Whether a model ID belongs to a generation Fletcher supports: GPT-5.6+,
 * Claude 5.5+, Gemini 3.5+. Applies to own-key model lists too.
 */
export const isSupportedGeneration = (vendor: ModelVendor, id: string) => {
  const { pattern, minimum } = GENERATION[vendor];
  const match = pattern.exec(id);

  if (match === null) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2] ?? "0");

  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
};

/** A model the paid plan offers: in the catalog and not excluded. */
export const isPlanModel = (model: CatalogModel) => model.weight !== null;

/** Above this estimated input, a review costs LARGE_REVIEW_MULTIPLIER × credits. */
export const LARGE_REVIEW_INPUT_TOKENS = 40_000;

export const LARGE_REVIEW_MULTIPLIER = 3;

/** Rough prompt size from the diff: ~3.5 bytes a token plus the prompt itself. */
export const estimateInputTokens = (diffBytes: number) =>
  Math.ceil(diffBytes / 3.5) + 1_500;

/**
 * A review's cost in credits × 100 (integers keep sums exact), or null for
 * a model the plan doesn't offer.
 */
export const reviewCreditsX100 = (
  model: CatalogModel,
  estimatedInputTokens: number,
): number | null =>
  model.weight === null
    ? null
    : Math.round(model.weight * 100) *
      (estimatedInputTokens > LARGE_REVIEW_INPUT_TOKENS
        ? LARGE_REVIEW_MULTIPLIER
        : 1);

/**
 * Cheaper plan models from the same vendor, most expensive first. A review
 * that can't afford its chosen model switches to the first that fits; it
 * never crosses vendors, since an admin may have picked one for data reasons.
 */
export const downgradeOrder = (model: CatalogModel): readonly CatalogModel[] =>
  model.weight === null
    ? []
    : MODEL_CATALOG.filter(
        (candidate) =>
          candidate.vendor === model.vendor &&
          candidate.weight !== null &&
          model.weight !== null &&
          candidate.weight < model.weight,
      );

/** What a review actually cost us, in millionths of a dollar. */
export const reviewCostUsdMicros = (
  model: CatalogModel,
  inputTokens: number | null,
  outputTokens: number | null,
) =>
  Math.round(
    (inputTokens ?? 0) * model.inputUsdPerMillion +
      (outputTokens ?? 0) * model.outputUsdPerMillion,
  );

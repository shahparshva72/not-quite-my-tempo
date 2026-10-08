# Design: bring your own key for Gemini, OpenAI, and Anthropic

Status: **draft 2026-10-07**, not built. Extends
[BYOK_TRIAL_DESIGN.md](./BYOK_TRIAL_DESIGN.md) and
[BILLING.md](./BILLING.md). Prices and the arithmetic behind the credit
numbers are in [MODEL_PRICING.md](./MODEL_PRICING.md).

## Implementation status (2026-10-08)

Built on branch `feat/multi-provider-byok`: the reviewer adapters, model
catalog, key checks, settings, credits, and workflow. It differs from the
plan below in a few places:

- **One migration, `0015`,** carries both the own-key columns and the
  credit columns, since neither has shipped.
- **Column names kept.** OpenAI and Anthropic keys reuse
  `gemini_key_*`, with `gemini_key_provider` widened to
  `openai`/`anthropic` (SQLite has no CHECK on it), instead of a new
  `review_key_provider` column and backfill. The Drizzle property names are
  unchanged too.
- **Audit actions** are `review_key.saved`, `review_key.removed`,
  `review_model.changed`, and `plan_model.changed`.
- **Run error codes.** New runs use `review_error` where `gemini_error`
  was used. Old codes stay readable in the UI.
- **Not built yet:** the `credit_cost_drift` daily log, the price-sync
  script (prices are in `catalog.ts` by hand), and the manual end-to-end
  test with real keys (step 7).

## Goal

Two parts that share one reviewer layer:

1. **Free tier, bring your own key**: a workspace can bring an **OpenAI**,
   **Anthropic**, or **Gemini** (Gemini API or Vertex express) key and
   **pick any model** that key can use. There are no limits; the workspace
   pays its provider.
2. **Paid plan, credits**: the one existing $10/month plan. Reviews run on
   Fletcher's platform keys. The workspace picks a model from a fixed
   catalog (Lite, Standard, and Pro tiers; no expensive or frontier
   models), and each review spends **credits** from a monthly allowance
   of **200**. See "Paid plan credits".

**Bring-your-own-key reviews never use credits**, on any plan.

Unchanged:

- **Trial**: 5 reviews on the platform Gemini key and default model
  (`key_source = 'platform'`), the daily trial cap, and the derived
  counting. Trial reviews don't use credits.

Changed: the **key order** in `chooseReviewKey` becomes paid credits →
workspace key → trial → none. A paid workspace spends its credits first and
then continues on its own key, if one is set. Otherwise it's blocked at 0
credits. See "Which key a paid workspace uses".

Out of scope: any plan besides the one $10 plan (team or higher plans
come later), several keys per workspace, fallback between providers,
ChatGPT/Claude subscription sign-in, other providers (OpenRouter, Bedrock,
Azure), and model choice in `.fletcher.json`.

## Library choice: hand-written adapters (spike result, 2026-10-08)

The Step 0 spike tried `@effect/ai` (the Effect v3 line, which needs
`@effect/ai@0.37.0`, `@effect/ai-openai@0.41.0`,
`@effect/ai-anthropic@0.27.0`, and `@effect/ai-google@0.16.0`; `latest`
is v4-only). **It failed on Workers.** The Fallback path is what shipped:

- `AnthropicLanguageModel` imports `@anthropic-ai/tokenizer` at module
  load. That's a CommonJS package that pulls in `tiktoken`'s WASM, and it
  doesn't load in workerd: the Workers Vitest pool failed before running a
  test.
- `OpenAiLanguageModel` imports `gpt-tokenizer`. The Worker grew from
  334 KiB to 891 KiB gzipped (3.9 MB raw), mostly BPE tables we never use.
- The Vercel AI SDK was ruled out earlier: it's Promise-based, has its own
  retries, and needs `zod`.

`packages/reviewer` holds three small `fetch` adapters behind one
`Reviewer` service. The Worker is now 336 KiB gzipped (+2 KiB):

| Provider            | Endpoint                                                | Structured output                                                               |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Gemini API / Vertex | `generateContent` (Vertex: `/v1/publishers/google/...`) | `responseMimeType` + `responseSchema` (`geminiResponseJsonSchema`)              |
| OpenAI              | `POST /v1/responses`, `store: false`                    | `text.format` `json_schema`, `strict: true` (`reviewJsonSchema`)                |
| Anthropic           | `POST /v1/messages`, `anthropic-version: 2023-06-01`    | one forced tool, `fletcher_review`, with `reviewJsonSchema` as its input schema |

The adapters share the rest:

- **Validation.** The model's JSON is decoded with the Effect
  `GeminiReview` schema, refinements included. Failing replies become
  `ReviewOutputInvalidError`.
- **Errors.** `failureReasonFor` sorts non-2xx answers (Errors table).
- **Retries.** The existing timeout and retry schedule.
- **Tests.** They inject `fetchImpl`, as before.

If the project moves to Effect v4, revisit `effect/unstable/ai`. Its
providers would have to drop the eager tokenizer imports first.

## Package layout

`packages/gemini` is now **`packages/reviewer`**
(`@not-quite-my-tempo/reviewer`), built in step 1:

```
packages/reviewer/src/
  prompt.ts     unchanged (buildSystemPrompt, buildReviewUserPrompt)
  schema.ts     GeminiReview (Effect schema), geminiResponseJsonSchema,
                reviewJsonSchema (strict JSON Schema for OpenAI/Anthropic)
  catalog.ts    ReviewProvider, MODEL_CATALOG (tiers, weights, prices),
                DEFAULT_MODELS, isSupportedGeneration, credit maths,
                downgradeOrder, reviewCostUsdMicros
  reviewer.ts   Reviewer tag + ReviewerLive(config): one fetch adapter per
                provider, shared decode, timeout, and retries
  errors.ts     ReviewProviderError (reason), ReviewOutputInvalidError,
                ReviewTimeoutError, failureReasonFor
  key-check.ts  Gemini key check (OpenAI/Anthropic checks: step 4)
```

```ts
export interface ReviewerConfig {
  readonly provider: ReviewProvider;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string; // tests
  readonly fetchImpl?: typeof fetch; // tests
  readonly timeoutMillis?: number; // default per provider
}

export interface ReviewResult {
  readonly review: GeminiReview;
  readonly provider: ReviewProvider;
  readonly model: string;
  readonly usage: ReviewUsage; // input/output/total, null when absent
}
```

Per-provider request settings stay in the adapter, never in the workflow:

| Provider        | Settings                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini / Vertex | `temperature: 0.2` (today's value)                                                                                                                              |
| OpenAI          | No `temperature` (reasoning models reject it); `reasoning: { effort: "low" }` only when the model is a reasoning model, else `temperature: 0.2`; `store: false` |
| Anthropic       | `max_tokens: 16_000` (Anthropic requires a cap; long reviews need room); `temperature: 0.2`; no `thinking` (it conflicts with a forced tool choice)             |

Timeouts: 60 s for Gemini (as today), 180 s for OpenAI and Anthropic,
since reasoning models and long outputs are slower. Workflow steps wait
on I/O, so CPU limits aren't a concern.

The reasoning flag lives on each catalog entry. OpenAI models outside the
catalog (own keys) are treated as reasoning models, since every supported
GPT generation is one.

## Data

Migration `0015`, additive and backward compatible:

```
workspaces
  + review_key_provider  text  -- 'gemini_api' | 'vertex_express' |
                               -- 'openai' | 'anthropic'; null = no key
  + review_model         text  -- model ID; null = provider default
  backfill: review_key_provider = coalesce(gemini_key_provider, 'gemini_api')
            WHERE gemini_key_ciphertext IS NOT NULL

review_runs
  + provider             text  -- which API ran the review; null = never ran
                               -- (old rows: 'gemini_api' via backfill when model is set)
```

- **The SQL names of the key columns stay** (`gemini_key_ciphertext`,
  `gemini_key_last4`, `gemini_key_updated_at`, `gemini_key_updated_by`).
  Only the Drizzle **property names** change, to `reviewKeyCiphertext`,
  `reviewKeyLast4`, and so on. Drizzle maps them, so there's no SQL rename
  and no migration risk.
- `gemini_key_provider` becomes unused. Drop it in a later migration, once
  `0015` has been in production for a release.
- **Encryption context**: `reviewKeyContext(workspaceId, provider)` returns
  `workspace:<id>:gemini` for `gemini_api`/`vertex_express` (existing
  ciphertexts keep decrypting) and `workspace:<id>:<provider>` for the
  others. Binding the provider means a row edited to claim another
  provider fails to decrypt instead of sending a key to the wrong company.
- `review_model` is checked on save (see Model choice). When it's null,
  `DEFAULT_MODELS[provider]` is used. For Gemini, `GEMINI_MODEL` still
  overrides the default for the platform key only.
- Add `0015` to `apps/api/test/setup.ts`. `resetAndSeedRepository` needs
  no change.

## Saving a key

`/workspaces/:id/settings` → the **"Review key"** card (it replaces
"Gemini key"):

1. The admin chooses a **provider** (radio: Anthropic, OpenAI, Gemini),
   pastes the key (password field, autocomplete off), and submits. There's
   no Vertex option: Gemini keys are still detected as Gemini API or Vertex
   express, as today.
2. **Format check** before any network call. It catches paste mistakes,
   not validity:
   - Anthropic: `sk-ant-` prefix.
   - OpenAI: `sk-` prefix. Warn when the key starts with `sk-ant-`, which
     means the wrong provider was chosen.
   - Gemini: today's `KEY_PATTERN`.
   - All: strip whitespace, quotes, and a whole `NAME=value` line.
3. **Key check**, a free call that doesn't spend tokens:
   - OpenAI: `GET https://api.openai.com/v1/models`.
   - Anthropic: `GET https://api.anthropic.com/v1/models` with
     `anthropic-version`.
   - Gemini: today's model list, then Vertex `countTokens`.

   Status mapping as in `checkGeminiKey`: 2xx accepted; 400/401/403/404
   rejected; anything else unavailable, so the key isn't stored and the
   form says "try again".

4. The same response fills the **model picker** (below). The key is stored
   encrypted with `last4`, `review_key_provider`, and `review_model =
null` (default). Audit `review_key.saved` with `{ provider, last4 }`.
   Removing a key audits `review_key.removed`.

Saving a key for a different provider **replaces** the old one; there's
still one key per workspace. A provider change also resets
`review_model`.

## Model choice ("any model")

A second form on the same card, shown once a key exists: `POST
/workspaces/:id/settings/review-model`.

- **Options**: the provider's model list, fetched when the settings page
  loads. It's cached in the isolate for 10 minutes per workspace, and the
  stored key is decrypted only inside the request.
  - OpenAI's list includes non-chat models, so drop IDs matching
    `embedding|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search`.
  - Anthropic and Gemini lists are used as returned (Gemini filtered to
    `supportedGenerationMethods` containing `generateContent`).
  - Only supported generations are listed: GPT-5.6+, Claude 5.5+, and
    Gemini 3.5+ (`isSupportedGeneration` in the catalog module). Within
    those, own-key workspaces can pick any model, expensive ones included.
  - The provider's default is preselected, labelled "Recommended".
  - If the list can't load, show a text field instead: "Model ID".
- **On save**: re-check the ID against a fresh list. Anything listed is
  allowed, which is what "any model" means here. No test generation
  (it costs the user money). Audit `review_model.changed`.
- **Default models** (`DEFAULT_MODELS`): a mid-priced current model per
  provider, chosen when this ships and reviewed every release. The
  constant is the only place model names appear.
- **Model retired later**: the review gets a 404 or a "model not found"
  answer and fails with `review_model_unavailable` (see Errors). It
  doesn't silently switch to another model.
- Small models may fail to produce valid structured output. That's a
  `review_output_invalid` failure, and the UI suggests a stronger model.

## Which key a review uses

`chooseReviewKey` keeps its order and its persisted step output
(`ReviewKeyChoice` has no secrets). `resolveGeminiKey` becomes
`resolveReviewKey`, which returns `ReviewerConfig`:

- `workspace` source → decrypt with `reviewKeyContext(id, provider)`,
  `provider = review_key_provider`, `model = review_model ??
DEFAULT_MODELS[provider]`.
- `platform` (trial) → `GEMINI_API_KEY`, `GEMINI_API_PROVIDER`,
  `GEMINI_MODEL ?? DEFAULT_MODELS.gemini_api`, as today.
- `subscription` (paid) → the model the run claimed credits for (see
  "Paid plan credits"), with the platform key for its provider:
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

The config is built and the key decrypted **inside** the step, so it's
never a step output, as today. **Keep the step name `"run gemini
review"`.** Workflows replay completed steps by name, so renaming it would
make a review that finished just before a deploy run again, and spend
tokens again. The name is only a cache key; a comment explains why it
says "gemini".

`persistReviewFindings` also records `provider`.
`performGeminiReview` → `performReview`, same body against the `Reviewer`
tag.

## Paid plan credits

### The plan

There is **one plan**. Team or higher plans are out of scope for now.

|                |                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Price          | $10 per workspace per month (the existing Polar product, unchanged)                               |
| Allowance      | 200 credits per billing period (`PLAN_MONTHLY_CREDITS`, default 200)                              |
| 1 credit       | about one typical-PR review on `gemini-3.8-flash`, ~$0.03 of model cost                           |
| Models         | the platform catalog: Lite, Standard, and Pro tiers only                                          |
| Not on plan    | expensive (Opus/`gpt-5.6`-class) and frontier models. They work only with the workspace's own key |
| Own-key review | never uses credits                                                                                |
| Unused credits | don't roll over                                                                                   |

Cost of one review, in credits:

```
credits = tier weight × size multiplier
tier weight:     Lite 0.5 · Standard 1 · Pro 3   (per-model override allowed)
size multiplier: 1, or 3 when estimated input > 40,000 tokens
estimated input: ceil(diff bytes / 3.5) + 1,500
```

Only current generations are supported: **OpenAI GPT-5.6 and newer,
Claude 5.5 and newer, and Gemini 3.5 and newer**. Older models (GPT-5.4
and below, Claude Haiku 4.5, Gemini 3.1, and below) are offered neither on
the plan nor in the own-key model picker.

| Tier     | Weight | Models (catalog at launch)                                                           | Reviews per 200 credits (typical PRs) |
| -------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------- |
| Lite     | 0.5    | `gpt-6-luna`, `gpt-5.6-luna`, `gemini-3.5-flash-lite`                                | 400                                   |
| Standard | 1      | `gemini-3.8-flash` (default), `gemini-3.7-flash`, `gemini-3.6-flash`                 | 200                                   |
| Pro      | 3      | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-terra`, `claude-sonnet-5-5`, `gemini-3.5-flash` | 66                                    |
| Excluded | —      | `gpt-5.6`, `gpt-5.6-sol`, `gpt-6-astra`, `claude-opus-5-5`, and pricier models       | own key only                          |

OpenAI has no Standard model in this range, and Claude has only Sonnet
5.5 until Haiku 5.5's price is published (below).

With a mix of PR sizes, the counts drop: about 166 Standard reviews or 55
Pro.

**Claude Haiku 5.5** launched on 2026-10-07. Anthropic says it costs
"around 75% less to run" than Haiku 4.5. As of 2026-10-08, models.dev,
OpenRouter, and Anthropic's model pages don't list its price or model ID
yet. When they do, add it through the price sync. At ~75% below Haiku
4.5 it would land in **Lite** (0.5), giving Claude a smaller model to
switch to. Don't guess its weight before the price is published.

**Why these numbers hold.** Sources: MODEL_PRICING.md; a 50/40/10
small/typical/large mix; Polar Starter fees with non-US cards, so $8.85 net
of $10.

- **A workspace that spends all 200 credits** costs $1.23–4.83 in model
  fees. Every allowed model keeps at least a 40% margin; the lowest is
  `gemini-3.5-flash-lite`.
- **At an assumed 50% average use** and a 65/25/10 Standard/Pro/Lite mix, a
  subscriber costs ~$2.25 and leaves ~$6.60. That's about $640/month at 100
  subscribers and $6,450 at 1,000.

These figures rest on token estimates. Recalibrate the weights and the 40k
threshold from production `review_runs` tokens before launch.

**Why fixed weights rather than real token cost**: the charge is known
**before** the model call, so it can be claimed atomically up front, the
same way a trial review is, and the user sees the price ("3 credits; 9
for a large PR") when choosing a model. The real cost is recorded too, as
a check on the weights (see Monitoring).

### Model catalog

`packages/reviewer/src/model-catalog.ts`, generated by
`scripts/sync-model-prices.ts` from models.dev (MODEL_PRICING.md, Keeping
prices current), with a hand-reviewed tier map:

```ts
export interface CatalogModel {
  readonly provider: ReviewProvider;
  readonly id: string;
  readonly tier: "lite" | "standard" | "pro" | "excluded";
  readonly weight: number | null; // null when excluded: not on the plan
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}
```

- A model is on the paid plan when its tier isn't `excluded` **and** the
  platform key for its provider is configured. If `ANTHROPIC_API_KEY` is
  unset, Claude models are hidden. This lets the plan launch with fewer
  providers.
- **Downgrade order** (see "Switching to a smaller model"): for each
  model, the cheaper catalog models **from the same provider**, most
  expensive first. It's derived from the weights, not hand-written. For
  example:
  - `gpt-6.1-sol` → `gpt-5.6-luna` → `gpt-6-luna`.
  - `gemini-3.5-flash` → `gemini-3.8-flash` → `gemini-3.7-flash` →
    `gemini-3.6-flash` → `gemini-3.5-flash-lite`.
  - `claude-sonnet-5-5` → nothing until Haiku 5.5 is added.
- A retired model is removed from the catalog in a release. Workspaces
  that chose it fall back to the default (`gemini-3.8-flash`) at their next
  review, and settings says so. Old runs keep their recorded model.

### Data

Migration `0016`, additive, shipped after `0015`:

```
workspaces
  + plan_model                text       -- catalog model ID; null = default
  + subscription_period_start timestamp  -- from Polar current_period_start

review_runs
  + credits_x100              integer    -- credits claimed × 100 (0.5 → 50,
                                         -- 1.25 → 125, 9 → 900); null = none
  + credits_workspace_id      integer references workspaces(id) on delete set null
  + credits_period_start      timestamp  -- which period the claim counts in
  + cost_usd_micros           integer    -- real cost: tokens × snapshot price
  + requested_model           text       -- plan_model when the run started; differs
                                         -- from model when it was switched down
  index (credits_workspace_id, credits_period_start)
```

- **Integers, not floats**: credits are stored × 100, so sums are exact
  and a 1.25 weight is representable. They're shown divided by 100.
- `subscription_period_start` comes from the same Polar read that sets
  `subscription_period_end` (`syncWorkspacePlan`; add
  `current_period_start` to the `polar-client.ts` schema).
- `credits_workspace_id` and `credits_period_start` are fixed at claim
  time, for the same reason as `trial_workspace_id`: a repository transfer
  or a later period change can't move a claim.

### Counting and claiming (no counter)

Like the trial, credits used is **derived**: claims count while their run
is `queued`, `running`, or `completed`. Failed and cancelled runs stop
counting, so a failed review refunds itself. A `/fletcher again` retry
clears the claim (`requeueFailed`) and claims again. We pay for the model
calls of failed reviews.

```sql
-- used this period
SELECT coalesce(sum(credits_x100), 0) FROM review_runs
WHERE credits_workspace_id = :ws AND credits_period_start = :period_start
  AND status IN ('queued', 'running', 'completed')

-- claim: one statement, so concurrent runs can't overspend
UPDATE review_runs
SET key_source = 'subscription', credits_x100 = :cost,
    credits_workspace_id = :ws, credits_period_start = :period_start,
    model = :model, provider = :provider
WHERE id = :run AND key_source IS NULL
  AND (<used this period>) + :cost <= :allowance_x100
```

The claim happens in the existing **"choose gemini key"** step:

- That step now also receives the diff size from the "fetch pull request"
  step output, for the size multiplier.
- It records the claimed model on the run, so the "run gemini review" step
  uses exactly what was paid for, even if an admin changes the model in
  between.
- A retried step finds `key_source` already set and claims nothing, as
  with the trial.

`ReviewKeyChoice` gains `model` and `credits`. Neither is a secret, so the
step output stays safe to persist.

### Which key a paid workspace uses

A paid workspace spends **credits first**, switching to a smaller model
when the chosen one no longer fits. Then it falls back to its own key if
it has one; otherwise the review is blocked:

1. **Chosen model.** Claim credits for `plan_model ?? default`. If the
   claim succeeds, the run uses that model (`key_source = 'subscription'`).
2. **Smaller model.** If the chosen model costs more than the credits
   left, claim the first model in its downgrade order that fits (same
   provider, most expensive first). The run gets a notice (below).
3. **Own key, if set.** If no plan model fits, the run uses the
   workspace's own key and model (`key_source = 'workspace'`). It spends
   no credits and has no limits from us. There's no PR comment; settings
   shows "Plan credits used up; reviews use your own key until {date}".
4. **Blocked.** No own key: the run fails with `credits_exhausted`. Once
   no plan model fits, only an own key keeps reviews running.

A workspace that isn't paid keeps today's order: own key → trial → none.

So `chooseReviewKey` becomes **paid → workspace key → trial → none**.
Paying for the plan is then never wasted on a workspace that also has its
own key, and the key becomes the overflow.

Own-key reviews never spend credits, on any plan. They work with any model
the key can use, excluded tiers included.

The billing grace period (`hasPaidPlan`: 3 days after `period_end`) keeps
spending against the old period's balance until the renewal webhook
stores the new `period_start`, which starts a fresh 200.

### Switching to a smaller model

- **Same provider only.** An admin who picked Claude may have picked
  Anthropic for data reasons. A downgrade must never send the code to
  OpenAI or Google instead. If the provider has nothing cheaper that fits,
  go to step 3 (own key) or 4 (blocked).
- **Chosen in the "choose gemini key" step.** The step reads the
  remaining credits, walks the downgrade order, and runs the same atomic
  claim with the smaller model's cost.
  - If a concurrent run took the credits first and the claim fails, it
    re-reads the balance and walks the order once more. After that it
    moves on to step 3.
  - It records `model` (what runs) and `requested_model` (what the admin
    picked) on the run.
- **Large PRs** multiply every candidate by 3: Pro 9 → Standard 3 → Lite
  1.5.
- **Notice on the review.** The posted review gets one line above the
  verdict, in plain words:

  > Switched to a smaller model: this review used `gemini-3.8-flash`
  > (1 credit) instead of `gemini-3.5-flash` (3 credits), because the
  > workspace has 2 credits left until {renewal date}.

  The run page shows "gemini-3.8-flash (switched from gemini-3.5-flash)".
  The settings meter turns to "Low on credits: reviews are switching to
  smaller models". There's no separate PR comment; the notice is in the
  review itself. Log `review_model_downgraded`.

**Example.** Workspace on `gemini-3.5-flash` (3 credits, 9 for a large
PR), no own key, 2 credits left:

| Next PR | Credits left | Chosen fits? | Switch                                  | Credits after |
| ------- | ------------ | ------------ | --------------------------------------- | ------------- |
| Typical | 2.00         | No (3)       | `gemini-3.8-flash`, 1, runs with notice | 1.00          |
| Typical | 1.00         | No (3)       | `gemini-3.8-flash`, 1, runs with notice | 0.00          |
| Typical | 0.00         | No           | nothing fits → own key, or blocked      | 0.00          |

A large PR with 2 credits left skips `gemini-3.8-flash` (3) and runs on
`gemini-3.5-flash-lite` (1.5).

- **OpenAI on `gpt-6.1-sol`** with 2 credits left switches straight to
  `gpt-5.6-luna` (0.5), since there's no OpenAI Standard model: four more
  reviews, then blocked.
- **Claude on `claude-sonnet-5-5`** has nothing smaller yet, so it goes
  directly to the own key or is blocked.

### Out of credits

Only reached when no model from the chosen provider fits the remaining
credits **and** the workspace has **no own key** (with a key, reviews
continue on it; see above). Reviews stay blocked until credits renew or an
admin adds a key. `credits_exhausted` posts one PR comment per pull request
per period (`hasEarlierBlockedRun`, keyed on code + period):

> ### 🥁 Fletcher can't review this yet
>
> This workspace has used its 200 review credits for this period (they
> renew on {date}). To keep reviewing now, an admin can add your own
> OpenAI, Anthropic, or Gemini key at {settings link}, then comment
> `/fletcher again` here.

Example: the Claude workspace above has 0.75 credits left after its
downgraded review.

- **With an own key** (say OpenAI, model `gpt-6.1-sol`): the next review
  runs on that key and spends 0 credits. The 0.75 stays unused until
  renewal.
- **Without one**: blocked, with the comment above.

### Monitoring

- Each paid run records `cost_usd_micros`, computed from the run's token
  counts and the catalog price.
- A daily log line, from the existing 15-minute cron or a new daily one,
  sums actual cost per workspace per period. It logs
  `credit_cost_drift` when that sum exceeds 1.5× (credits used × $0.03),
  which means the weights or size estimate are off for that workspace.
- `review_credits_exhausted` is logged with the workspace and model. How
  often workspaces hit it shows whether 200 is the right allowance.

## Errors

`classifyAiError(provider, error)` turns `AiError` into Fletcher's errors.
It is the only provider-specific error logic:

| Fletcher error              | Gemini                                         | OpenAI                                  | Anthropic                                             | Retry? |
| --------------------------- | ---------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------ |
| `ReviewKeyRejected`         | 400 `API_KEY_INVALID`, 401, 403                | 401                                     | 401 `authentication_error`, 403 `permission_error`    | no     |
| `ReviewQuotaExceeded`       | 429 with `RESOURCE_EXHAUSTED` quota (not rate) | 429 `insufficient_quota`                | 400 `invalid_request_error` mentioning credit balance | no     |
| `ReviewModelUnavailable`    | 404                                            | 404 `model_not_found`, 403 model access | 404 `not_found_error`                                 | no     |
| `ReviewRateLimited`         | 429                                            | 429 (other codes)                       | 429 `rate_limit_error`                                | yes    |
| `ReviewProviderUnavailable` | 5xx                                            | 5xx                                     | 5xx, 529 `overloaded_error`                           | yes    |
| `ReviewRequestFailed`       | network/`HttpRequestError`                     | same                                    | same                                                  | yes    |
| `ReviewOutputInvalid`       | `MalformedOutput`, schema decode               | same                                    | same                                                  | once   |
| `ReviewTimeout`             | timeout                                        | same                                    | same                                                  | yes    |

These codes are read from `HttpResponseError.body`. **Today's retry
retries every 429**, which would waste OpenAI `insufficient_quota` calls.
This table fixes that.

Run `error_code`s for a **workspace** key, shown on review pages and in a
PR comment (one per PR, using the `hasEarlierBlockedRun` dedupe):

| Code                       | Message                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `review_key_rejected`      | "Your workspace's {Provider} key was rejected; an admin can replace it in settings."                               |
| `review_quota_exceeded`    | "Your {Provider} account is out of credits or quota. Add credits with {Provider}, then comment `/fletcher again`." |
| `review_model_unavailable` | "The model {model} isn't available to this key anymore; an admin can pick another in settings."                    |
| `review_output_invalid`    | "{model} didn't return a usable review; try `/fletcher again` or a stronger model."                                |
| `review_key_unreadable`    | as `gemini_key_unreadable` today                                                                                   |

- `no_gemini_key` → `no_review_key`, and `gemini_key_rejected` /
  `gemini_key_unreadable` → the codes above, for **new** runs.
- `review-presentation.ts` keeps the old codes mapped for existing rows.
  `hasEarlierBlockedRun` matches old and new codes, so a PR blocked before
  the deploy isn't commented on again.
- Platform-key failures (trial/paid) keep today's behaviour: no
  workspace-facing key messages. Our quota problems are logged and alerted.
- `credits_exhausted`: paid workspace out of credits (see "Paid plan
  credits"). It's blocked before any model call, like `no_gemini_key`.

## UI and copy

Every user-facing "Gemini key" becomes **"review key"** or names the
provider. That's about 32 places in `dashboard/*.ts`, plus `review-keys.ts`
comments and the README.

- **Settings card "Review key"**:
  - Status line: "Reviews use your Anthropic key ending …AbCd, model
    {model}, added by {user} on {date}", or "{n} of 5 free reviews left".
  - Provider radios, the key field, a link to "where do I get a key?" for
    each provider's console, and Remove.
  - The model picker and "Recommended" label.
  - Members see the status; admins and owners act (existing
    `view_settings`/`manage_settings`).
- **Dashboard heading**: "Reviews use your OpenAI key" / "3 of 5 free
  reviews left".
- **Run page**: show `provider · model` and token usage.
- **Landing/pricing**:
  - Free: "5 trial reviews, then bring your own OpenAI, Anthropic, or
    Gemini key; pick any model".
  - Paid (the only plan): "$10/month · 200 review credits: up to 200
    reviews on standard models, 66 on pro models. Pick GPT, Claude, or
    Gemini. Reviews with your own key don't use credits."
  - Credits are described in reviews, not points. Provider names are in
    text only, with no logos.
- **Settings, paid plan card**:
  - A credits meter (the existing `Meter` component): "{used} of 200
    credits used · renews {date}".
  - A model picker grouped by tier. Each option shows its cost: "3 credits
    a review, 9 for a large PR · about {n} reviews left".
  - Admins change the model (`manage_settings`), audited as
    `plan_model.changed`.
- **Run page**: on a paid run, also show "{credits} credits".
- **Blocked-review comment** (`blockedComment`): "add an OpenAI, Anthropic,
  or Gemini key".
- Same dark Stage-light theme, server-rendered, with no client JS
  needed: the provider radios work as plain form fields.

## Legal, config, docs

- **`legal.ts`**:
  - The privacy policy names OpenAI and Anthropic, alongside Google, as
    processors that receive PR content **when a workspace chooses them**,
    under the workspace's own account and that provider's terms. Note
    OpenAI's `store: false`.
  - The terms say provider charges and limits are between the workspace
    and the provider.
  - Update the "last updated" date.
- **Terms** also cover credits: credits renew each billing period, don't
  roll over, and aren't refundable. A review that fails doesn't use them.
- **Env** (update `.env.example` and the README in the same change):
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`: optional secrets, platform keys
    for paid-plan reviews on those providers. When one is unset, that
    provider's models aren't offered on the paid plan.
  - `PLAN_MONTHLY_CREDITS`: optional, default 200, a plain var.
  - Reword `GEMINI_API_KEY`'s comment to "platform key for trial and paid
    Gemini reviews".
  - Provider endpoints are constants; tests override them through the
    `HttpClient` layer.
  - Run `pnpm db:types` afterwards.
- **Docs**:
  - Update `BYOK_TRIAL_DESIGN.md` (link here) and the key order in
    `BILLING.md`.
  - In the README, setup stays the same; describe the features.
  - In AGENTS.md, rename `packages/gemini` → `packages/reviewer`, and note
    "`@effect/ai*` pinned to the Effect v3 `0.x` line; don't take
    `latest`".

## Security

- Keys exist decrypted only inside the "run review" step and the settings
  request that checks them. They are `Redacted` from decrypt to header.
- Tests:
  - No key material in step outputs, rendered HTML, `audit_events`
    (last4 only), or logged `AiError`s. Feed a fake key through a failing
    response and assert it's absent from the error's string form.
  - Model IDs from the form are checked against the provider list and
    escaped in HTML. They go only into JSON bodies, never into URLs,
    except Gemini's path, where the ID must match `^[A-Za-z0-9._-]+$`.
- Existing same-origin POST middleware and the `manage_settings` check
  cover the new forms.

## Failure modes

| Failure                                 | Behaviour                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User picks the wrong provider for a key | Format check or key check rejects it; nothing stored                                                                                                                    |
| Provider down during save               | Not stored; "{Provider} didn't answer; try again"                                                                                                                       |
| Key revoked at the provider             | `review_key_rejected`, one PR comment, no trial use                                                                                                                     |
| Account out of credit                   | `review_quota_exceeded`, no retries                                                                                                                                     |
| Model retired                           | `review_model_unavailable`; admin picks another                                                                                                                         |
| Weak model returns junk                 | One retry, then `review_output_invalid`                                                                                                                                 |
| Key changed mid-run                     | The run uses whatever it decrypts in its step. A different provider than the run's recorded one is fine, because `provider` is recorded at persist time                 |
| Deploy during a running review          | Completed steps replay from cache, because the step name is kept (see above)                                                                                            |
| `@effect/ai` v3 provider bug            | Fall back to a hand-written adapter for that provider only, behind `Reviewer`                                                                                           |
| Two paid runs race for the last credits | The conditional claim lets only runs that fit succeed. A loser re-walks the downgrade order once, then uses the own key if set, else fails `credits_exhausted` (tested) |
| Downgraded review                       | Runs on the smaller same-provider model; the review carries the "Switched to a smaller model" notice; `requested_model` keeps the admin's choice                        |
| Chosen provider has no model that fits  | No switch to another provider (data stays with the provider the admin picked); own key if set, else blocked                                                             |
| Credits gone, own key then fails        | Normal own-key errors (`review_key_rejected`, `review_quota_exceeded`, …); no credits are touched                                                                       |
| Paid review fails after claiming        | The run is `failed`, so its credits stop counting; `/fletcher again` claims again                                                                                       |
| Admin changes model mid-run             | The run uses the model it claimed for, recorded on the run                                                                                                              |
| Renewal webhook late                    | Grace period keeps the old period's balance; the next sync starts a fresh 200                                                                                           |
| Catalog model retired                   | Removed in a release; affected workspaces use the default model and settings say so                                                                                     |
| A platform key's provider down          | Retries per the Errors table; then the run fails and its credits stop counting. No switch to another provider                                                           |
| Weights too low for real usage          | `credit_cost_drift` log; adjust weights in the catalog                                                                                                                  |
| Paid workspace picks an excluded model  | Not offered on the plan picker; the settings POST rejects any model outside the Lite/Standard/Pro catalog                                                               |

## Build sequence

0. **Spike (half a day, decides the library).** Add the four packages and
   build one `generateObject` call per provider with the real
   `FletcherReview` schema and prompt. Run each against a real key with a
   fixture diff, and measure the `pnpm build` bundle size. The spike
   passes when all three return valid reviews and the bundle stays under
   the Workers limit with room to spare. If it fails, take the Fallback
   path.
1. **Rename `packages/gemini` → `packages/reviewer`** and add the
   `Reviewer` service, with Gemini/Vertex on `@effect/ai-google`. No
   behaviour change; the existing `gemini-reviewer.test.ts` (renamed) still
   passes against a test `HttpClient`.
2. **OpenAI and Anthropic adapters** with per-provider settings,
   `classifyAiError`, the retry fix, and tests from recorded responses:
   success, each error row, a malformed output, and a truncated Anthropic
   `max_tokens` stop.
3. **Migration `0015`**, the repository changes (property renames,
   `review_key_provider`, `review_model`, `review_runs.provider`), and
   `reviewKeyContext`.
4. **Key check and model listing** per provider, plus `saveReviewKey`,
   `saveReviewModel`, and audit events.
5. **Workflow**: `resolveReviewKey`, `performReview`, the new error codes
   and comments, and old-code compatibility in presentation and dedupe.
6. **UI and copy**: settings card, dashboard, run page, landing, and
   `legal.ts`.
7. **Paid plan credits** (needs steps 1–5):
   - Model catalog and price sync script.
   - Migration `0016`, plus `period_start` in the Polar sync.
   - The atomic claim, with a race test for the last credits.
   - Same-provider downgrade, `requested_model`, and the "Switched to a
     smaller model" notice. Tests: the downgrade order, never crossing
     providers, and the large-PR multiplier.
   - Own-key fallback, then `credits_exhausted` and its comment.
   - Settings meter and model picker, pricing copy, terms, platform keys,
     and `cost_usd_micros` with the drift log.
   - Ship it behind `PLAN_MONTHLY_CREDITS`; the paid plan stays
     Gemini-only until the platform keys are set.
8. **Verify**: `pnpm lint` → `pnpm format:check` → `pnpm build` →
   `pnpm test`, plus `pnpm typecheck` and `typecheck:test`. Manual test:
   one real review per provider on a test repo, added to
   `docs/MANUAL_TESTING.md`.

## Open questions

1. **Default models.** Pick the three `DEFAULT_MODELS` at implementation
   time: a mid-priced model per provider that reliably returns the
   structured review. Step 0's spike results should decide.
2. **Recalibrate before launch.** Weights, the 40k size threshold, and
   the large multiplier (3 vs 3.5) use estimated tokens. Rerun
   MODEL_PRICING.md's numbers with production averages.
3. **Prompt tuning per provider.** The Fletcher persona prompt was
   written for Gemini. Start with one shared prompt and compare outputs
   in the spike before forking it.

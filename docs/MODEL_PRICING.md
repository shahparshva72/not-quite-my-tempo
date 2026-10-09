# Model pricing and review limits

Status: **research 2026-10-07**. Companion to
[MULTI_PROVIDER_BYOK_DESIGN.md](./MULTI_PROVIDER_BYOK_DESIGN.md). Nothing
is built.

## Sources

- **[models.dev](https://models.dev/api.json)** is the main source. It
  lists every provider (`openai`, `anthropic`, `google`, `google-vertex`,
  and 70+ more) with `cost.input`/`cost.output` in USD per million tokens,
  `cache_read`, long-context `tiers`, `limit.context`,
  `structured_output`, `reasoning`, and `status: "deprecated"`.
- **[OpenRouter](https://openrouter.ai/api/v1/models)** is the cross-check.
  All 14 models I checked against it had **identical** input and output
  prices.

Both were fetched on 2026-10-07. Prices change, so the numbers below are a
snapshot (see Keeping prices current).

## Who these limits are for

| Review source            | Who pays           | Limit by model?                                                    |
| ------------------------ | ------------------ | ------------------------------------------------------------------ |
| Workspace key (BYOK)     | The workspace      | **No.** Any model, no cap. Show the estimated cost per review only |
| Trial (5 reviews)        | Us                 | Fixed model: the platform Gemini model                             |
| Paid plan (platform key) | Us, from plan fees | **Yes.** This is where model-weighted limits apply                 |

The paid plan is Gemini-only today. Model-weighted limits only matter if
the paid plan offers a choice of models (open question 2 in the BYOK
design). This doc gives the numbers either way.

## Token assumptions per review

Fletcher sends a system prompt (~1k tokens) plus PR title, body, diff,
and prior findings, and gets structured JSON back. Output includes
reasoning tokens, which every provider bills as output.

| Scenario   | Input  | Output (incl. reasoning) | Example                                             |
| ---------- | ------ | ------------------------ | --------------------------------------------------- |
| Small PR   | 6,000  | 2,000                    | A few files                                         |
| Typical PR | 20,000 | 4,000                    | A feature PR                                        |
| Large PR   | 90,000 | 8,000                    | Near the 300 KB diff cap (`DEFAULT_MAX_DIFF_BYTES`) |

The local database holds only 2 measured runs (~1.3k in / ~0.2k out /
~2.3k total, so Gemini spent ~0.8k on thinking). **Replace these
assumptions with production averages** from `review_runs.input_tokens` /
`output_tokens` before setting real limits:

```sql
SELECT key_source, model, count(*),
       avg(input_tokens), avg(output_tokens), max(input_tokens)
FROM review_runs WHERE input_tokens IS NOT NULL GROUP BY 1, 2;
```

Run this against production yourself; it's read-only, but AGENTS.md
warns that `--remote` hits prod.

Our largest input (~90k) is under the 200k/272k thresholds where
`gpt-6-*`, `gpt-5.4+`, and `gemini-*-pro` switch to long-context prices,
so base prices apply.

## Cost per review

USD; $/M = per million tokens, input / output. "×" is the typical-PR cost
relative to the current platform model, `gemini-3.8-flash` ($0.03).

| Provider  | Model                      | $/M in / out | Small   | Typical | Large  | ×      | Typical reviews per $10 |
| --------- | -------------------------- | ------------ | ------- | ------- | ------ | ------ | ----------------------- |
| openai    | `gpt-6-luna`               | 0.10 / 0.50  | $0.0016 | $0.0040 | $0.013 | 0.13×  | 2,500                   |
| google    | `gemini-3.1-flash-lite`    | 0.25 / 1.50  | $0.0045 | $0.0110 | $0.035 | 0.37×  | 909                     |
| openai    | `gpt-5-mini`               | 0.25 / 2.00  | $0.0055 | $0.0130 | $0.038 | 0.43×  | 769                     |
| google    | `gemini-3.5-flash-lite`    | 0.30 / 2.50  | $0.0068 | $0.0160 | $0.047 | 0.53×  | 625                     |
| google    | `gemini-3.8-flash` ★       | 0.75 / 3.75  | $0.0120 | $0.0300 | $0.098 | 1.00×  | 333                     |
| openai    | `gpt-5.4-mini`             | 0.75 / 4.50  | $0.0135 | $0.0330 | $0.103 | 1.10×  | 303                     |
| anthropic | `claude-haiku-4-5`         | 1 / 5        | $0.0160 | $0.0400 | $0.130 | 1.33×  | 250                     |
| google    | `gemini-3.5-flash`         | 1.50 / 9     | $0.0270 | $0.0660 | $0.207 | 2.20×  | 151                     |
| openai    | `gpt-6-sol`, `gpt-6.1-sol` | 2 / 10       | $0.0320 | $0.0800 | $0.260 | 2.67×  | 125                     |
| anthropic | `claude-sonnet-5-5`        | 2 / 10       | $0.0320 | $0.0800 | $0.260 | 2.67×  | 125                     |
| google    | `gemini-3.1-pro-preview`   | 2 / 12       | $0.0360 | $0.0880 | $0.276 | 2.93×  | 113                     |
| openai    | `gpt-5.6`                  | 4 / 20       | $0.0640 | $0.1600 | $0.520 | 5.33×  | 62                      |
| anthropic | `claude-opus-5-5`          | 4 / 20       | $0.0640 | $0.1600 | $0.520 | 5.33×  | 62                      |
| openai    | `gpt-6-astra`              | 10 / 50      | $0.1600 | $0.4000 | $1.300 | 13.33× | 25                      |
| anthropic | `claude-fable-5-1`         | 10 / 50      | $0.1600 | $0.4000 | $1.300 | 13.33× | 25                      |

★ is the current platform/trial model.

**Excluded**: deprecated models (`o4-mini`, `o3-mini`, `gpt-4.1-nano`,
`gemini-3.1-flash-lite-preview`, …); models without structured output
(`gpt-5.4-pro`, `gpt-5.2-pro`); `*-pro` reasoning tiers at $15–30 /
$120–180 per M; and image, audio, TTS, and embedding models.

What stands out:

- Cost per typical review ranges **100×** across the providers, from
  $0.004 (`gpt-6-luna`) to $0.40 (`gpt-6-astra`, `claude-fable-5-1`).
- Each provider's mid-tier model (`gpt-6.1-sol`, `claude-sonnet-5-5`,
  `gemini-3.1-pro-preview`) lands around **$0.08–0.09**, about 2.7–3× our
  current model.
- **PR size matters as much as the model.** A large PR costs ~3.3× a
  typical one on any model.
- The trial costs us ~$0.15 per workspace on typical PRs and ≤ $0.49 at
  worst (5 × large).

## Proposed limits for the platform key (paid plan)

**Credits.** 1 credit = 1 typical review on `gemini-3.8-flash` ≈ $0.03.
A review's cost in credits is **tier weight × size multiplier**, and both
are known **before** the model call: the model comes from settings, and
the size from the fetched diff. So the workflow can check and reserve
credits in the "choose key" step, the same way it claims a trial review
today, instead of finding out after spending.

**Decided 2026-10-07**: one plan, the existing **$10/month with 200
credits**, on Lite, Standard, and Pro models only. Expensive (Max) and
frontier models are own-key only. Own-key reviews never use credits.
Team or higher plans come later. The design is in
[MULTI_PROVIDER_BYOK_DESIGN.md](./MULTI_PROVIDER_BYOK_DESIGN.md), "Paid
plan credits".

| Tier     | Weight | Models (current)                                                                              | Real cost range  |
| -------- | ------ | --------------------------------------------------------------------------------------------- | ---------------- |
| Lite     | 0.5    | `gpt-6-luna`, `gemini-3.1-flash-lite`, `gpt-5-mini`, `gemini-3.5-flash-lite`                  | 0.13–0.53×       |
| Standard | 1      | `gemini-3.8-flash`, `gpt-5.4-mini`; `claude-haiku-4-5` at 1.25                                | 1.0–1.33×        |
| Pro      | 3      | `gemini-3.5-flash`, `gpt-6.1-sol`, `gpt-6-sol`, `claude-sonnet-5-5`, `gemini-3.1-pro-preview` | 2.2–2.93×        |
| Excluded | —      | `claude-opus-5-5`, `gpt-5.6` (5.33×), `gpt-6-astra`, `claude-fable-5-1` (13.33×)              | **own key only** |

- **Size multiplier**: ×1 for estimated input ≤ 40k tokens, ×3 above.
  Estimate input as `diff bytes / 3.5 + 1.5k`, and recalibrate once
  production data is in.
- **Monthly allowance**: 200 credits at $10. That's up to 200 Standard
  reviews, 400 Lite, or 66 Pro on typical PRs (about 166/333/55 with a
  50/40/10 size mix).
  - A workspace that uses all 200 credits costs $1.23–5.05 in model fees,
    out of $8.85 after Polar fees, so you keep at least 38%.
  - At 50% average use, a subscriber costs ~$2.25 and leaves ~$6.60.
- **Reconciliation backstop**: after each review, also record its actual
  cost (real tokens × snapshot price) in `review_runs`. Alert if a
  workspace's actual monthly cost is above 1.5× its credits × $0.03. That
  means the weights are off, and it guards against cheap labels on
  expensive runs.
- **Out of credits**: block the review with a one-time PR comment, the
  same pattern as `no_gemini_key`, offering a cheaper model, adding a
  BYOK key, or waiting for the reset.

Why fixed weights instead of billing actual token cost: users can see
before a review what it costs ("Pro model, 3 credits"). Actual cost is
only known after the call and depends on reasoning tokens we can't
predict. Tiers are rounded **up** within each band, so the margin holds.

## BYOK display

On the model picker, show the provider price and an estimated cost per
typical review, e.g. "~$0.08 per typical review". Mark models missing
from the snapshot as "price unknown". These numbers are informational
only; nothing is enforced.

## Keeping prices current

- Add `scripts/sync-model-prices.ts`. It fetches
  `https://models.dev/api.json`, keeps `openai`, `anthropic`, and `google`
  text models with `structured_output: true` and non-deprecated status,
  and writes `packages/reviewer/src/model-prices.ts` (input, output,
  context, reasoning, tier). It also writes the fetch date into the file.
  The tier assignment stays hand-reviewed in a separate map, so a price
  change shows up in the diff.
- Run it every release and in a monthly CI job that opens a PR when
  prices change. **Never fetch prices at runtime**: a third-party outage
  must not change what users are charged.
- **Platform-key rule**: a model with no tier can't be used on the
  platform key, but stays available for BYOK. New models therefore enter
  the paid plan only when we classify them.

## Open questions

1. **Paid plan price and target margin.** These turn the formula into an
   actual monthly credit number.
2. **Offer Pro/Max tiers on the paid plan at all?** Or keep paid on Lite
   and Standard and point heavier users to BYOK?
3. **Production token averages.** Run the query above, then revisit the
   40k size threshold and the scenario numbers.

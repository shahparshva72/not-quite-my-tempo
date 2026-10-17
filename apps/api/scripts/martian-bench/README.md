# Martian code review benchmark

Scores Fletcher on [Martian's offline benchmark](https://github.com/withmartian/code-review-benchmark)
(MIT): 50 pull requests from 5 open-source repos, with 173 human-written
golden comments. Everything bills to one Vertex AI API key.

- `review.ts` reviews each benchmark pull request through Fletcher's
  production path (diff filter, repository context, prompt, model, GitHub
  comment formatting) and adds the result to Martian's
  `results/benchmark_data.json` as one more tool. Martian's GitHub fork and
  App-install steps (0 and 1) are skipped.
- `judge-proxy.ts` serves an OpenAI Chat Completions endpoint on localhost
  backed by Gemini on Vertex AI, so Martian's judge (steps 2, 2.5 and 3) runs
  unchanged on the same key.

## Setup

```sh
git clone https://github.com/withmartian/code-review-benchmark ~/Documents/Developer/code-review-benchmark
cd ~/Documents/Developer/code-review-benchmark/offline
uv sync
cat > .env <<'EOF'
MARTIAN_API_KEY=unused
MARTIAN_BASE_URL=http://127.0.0.1:8788/v1
MARTIAN_MODEL=gemini-3.8-flash
EOF
```

`MARTIAN_API_KEY` must be non-empty but is never used; the proxy holds the
Vertex key. Judge results land in `results/gemini-3.8-flash/`.

In the shell that runs the scripts:

```sh
export VERTEX_API_KEY=...   # Vertex AI API key, in the project with the credits
BENCH=~/Documents/Developer/code-review-benchmark/offline
```

## Run

From this repository's root:

```sh
# 1. Estimate the cost. Calls GitHub only, never a model.
pnpm --filter @not-quite-my-tempo/api bench:review --bench-dir $BENCH --dry-run

# 2. Smoke test: one pull request per repo (5 reviews, a few cents).
pnpm --filter @not-quite-my-tempo/api bench:review --bench-dir $BENCH --per-repo 1

# 3. Everything else. Already reviewed pull requests are skipped.
pnpm --filter @not-quite-my-tempo/api bench:review --bench-dir $BENCH
```

The tool is named `fletcher-<model>` (for example
`fletcher-gemini-3.8-flash`). Use `--model gemini-4-argon` for the pro model,
`--no-context` to measure what repository context is worth, `--tool` to name
a variant, `--force` to review again, `--only <url>` for a single pull
request, and `--timeout <seconds>` to override production's 7-minute model
timeout. Each review prints its cost; failures are listed at the end, and
rerunning retries only those.

Then judge. Start the proxy in one terminal (Ctrl-C prints the judge's
bill):

```sh
pnpm --filter @not-quite-my-tempo/api bench:judge-proxy
```

and run Martian's steps for Fletcher in another, from `$BENCH`:

```sh
TOOL=fletcher-gemini-3.8-flash
uv run python -m code_review_benchmark.step2_extract_comments --tool $TOOL
uv run python -m code_review_benchmark.step2_5_dedup_candidates --tool $TOOL
uv run python -m code_review_benchmark.step3_judge_comments --tool $TOOL
uv run python analysis/benchmark_dashboard.py   # open analysis/benchmark_dashboard.html
```

Add `--limit 5` to steps 2 and 3 for a first look.

## Compare fairly

Martian's published scores were judged by Claude Opus 4.5, Claude Sonnet
4.5 and GPT-5.2. A Gemini judge scores differently, so compare Fletcher only
with tools judged by the same Gemini model. The other tools' reviews are
already in `benchmark_data.json`; rerun steps 2–3 with `--tool coderabbit`,
`--tool greptile-v5`, `--tool copilot-v2` and so on, at roughly $1–3 each.

Caveats:

- A Gemini judge scoring Gemini reviews may favor them.
- The pull requests are public and old, so models may have seen them
  in training.
- The proxy drops Martian's `temperature: 0` and thinks at
  `JUDGE_THINKING_LEVEL` (low by default). Keep both the same across every
  tool you compare.

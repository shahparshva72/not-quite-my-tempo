# Claude subscription review spike

Phase 1 of reviews that run on the user's Claude subscription in their own
GitHub Actions. `review.ts` does locally what a runner would do:

1. Builds the bundle `POST /runner/v1/claim` would return: production's
   system prompt and pull request prompt (diff filtered by `ignore`,
   `guidelines`, manifests; the changed files are left for Claude Code to
   read), under the repository's
   `.fletcher.json` `intensity` and `tone`.
2. Checks out the pull request head (`pull/<n>/head`, shallow).
3. Runs the official Claude Code CLI there with the flags the workflow would
   pass `anthropics/claude-code-action`: read-only tools (`Read`, `Grep`,
   `Glob`), `--json-schema` with `reviewJsonSchema`, no MCP servers, and
   none of your user settings.
4. Decodes `structured_output` with `GeminiReview`, applies
   `severityThreshold`, and prints the review as Fletcher would post it.

Nothing is posted to GitHub and no Fletcher credits are spent. The model call
runs on your local `claude` login. `ANTHROPIC_API_KEY` is removed from Claude
Code's environment so the subscription, not an API key, pays.

## Run

```sh
# Bundle only: no model call.
pnpm --filter @not-quite-my-tempo/api spike:claude-review \
  --pr shahparshva72/boundary-bytes#62 --bundle-only

# Full review, with a local .fletcher.json instead of the default branch's.
pnpm --filter @not-quite-my-tempo/api spike:claude-review \
  --pr shahparshva72/boundary-bytes#62 --config ./fletcher.test.json
```

`--model` picks the Claude model (default `claude-sonnet-5-5`), `--max-turns`
caps Claude Code's turns (default 40), and `--no-context` reviews the diff
alone. The checkout goes under the OS temp directory unless you pass
`--workdir <dir>`. The bundle (`system.md`, `prompt.md`, `schema.json`) and
the outputs (`result.json`, `review.md`) go in `<workdir>.fletcher/`, beside
the checkout rather than inside it.

## Findings so far

On boundary-bytes#62 (54 files, +850/−937), with `intensity: carnegie`,
`tone: ruthless` and `severityThreshold: warning`:

- The structured output decoded with `GeminiReview` on every run, with no
  retries. The `.fletcher.json` settings came through: the tone and the
  threshold showed in the output.
- **Don't hand the prompt over as a file in the checkout.** The first version
  wrote it to `.fletcher/task.md` and told Claude to read it (the plan's
  workaround for the action having no `prompt_file` input). Claude cited that
  file's line numbers (`LeagueContext.tsx:400` in a 196-line file), so no
  finding anchored to the diff. Passing the system prompt with
  `--append-system-prompt` and the pull request prompt on stdin fixed it:
  findings anchored at real lines.
- One run took about 30 seconds and 5–12 turns. Claude Code reported $0.24–0.58
  API-equivalent on Sonnet 5.5, which is what the user's plan absorbs.

## In GitHub Actions

[boundary-bytes#64](https://github.com/shahparshva72/boundary-bytes/pull/64)
(a throwaway draft) runs the same review of #62 in that repository's own
Actions, on its `CLAUDE_CODE_OAUTH_TOKEN` secret:

- **`anthropics/claude-code-action` can't carry the prompt.** It has no
  prompt-file input, and an inline `prompt` goes through the environment.
  The 290 KB prompt failed to start with "Argument list too long", because
  Linux caps one variable at 128 KiB. A prompt file in the checkout breaks
  line numbers (see above). So the workflow runs the unmodified CLI
  (`npm install -g @anthropic-ai/claude-code@<pinned>`), with
  `--append-system-prompt-file` and the prompt on stdin, and the token in
  that one step's environment. Anthropic's authentication docs describe
  exactly this use of `CLAUDE_CODE_OAUTH_TOKEN` in CI.
- That run passed. The job took 65 s in total: 7 s to install Fletcher, 4 s
  for the bundle, 49 s for Claude Code including its npm install, and 2 s to
  present. That bills about one Actions minute per review. The finding
  anchored inline (`LeagueContext.tsx:110`).
- Still open: `--setting-sources project` loads the checkout's
  `.claude/settings.json`, which a pull request can change. Its hooks
  could then run with the token in the environment. Check whether
  `--setting-sources` can exclude project settings before shipping, or
  read them from the default branch.

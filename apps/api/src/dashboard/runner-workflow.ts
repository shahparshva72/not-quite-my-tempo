import {
  CODEX_REVIEW_MINUTES,
  RUNNER_OIDC_AUDIENCE,
  RUNNER_WORKFLOW_FILE,
} from "../application/runner-jobs.js";
import type { RunnerAgent } from "../application/runner-jobs.js";
import { SITE_URL } from "./components.js";

// The workflows a repository commits to review on its owner's Claude or
// ChatGPT subscription. They must stay in step with apps/api/src/
// application/runner-jobs.ts: the claim and result bodies and the bundle's
// fields.
//
// Claude Code runs as the unmodified CLI, not claude-code-action: the
// action passes its prompt through the environment, and a large pull
// request's prompt fails with "Argument list too long". The token lives in
// the review step's environment only, and --setting-sources user keeps the
// pull request's own .claude/settings.json (and its hooks) from loading.
//
// Codex runs as the unmodified CLI too (codex exec), with a CODEX_HOME of
// its own under RUNNER_TEMP. Its read-only sandbox can read the whole disk,
// so the review runs under a permission profile that also denies reading
// CODEX_HOME, and its shell inherits only the core environment (no
// ACTIONS_ID_TOKEN_REQUEST_TOKEN). The pull request's AGENTS.md is kept out
// of the prompt; its .codex/config.toml doesn't load in an untrusted
// checkout. Each was checked against the pinned version. It signs in with
// a Codex access token (ChatGPT Business and Enterprise) or with the
// auth.json `codex login` writes (Plus and Pro). Codex rotates an auth.json
// session about every 8 days and the old refresh token then stops working,
// so the review job never rotates it: a scheduled job in the same file
// refreshes it ahead of time and writes it back to the repository secret.

/** Pinned so flags and output don't change under a repository. */
export const RUNNER_CLAUDE_CODE_VERSION = "2.1.318";

/** Pinned so flags and output don't change under a repository. */
export const RUNNER_CODEX_VERSION = "0.167.1";

/** The secret the Codex workflow's scheduled job writes auth.json back with. */
export const CODEX_AUTH_WRITE_TOKEN_SECRET = "CODEX_AUTH_WRITE_TOKEN";

// The claim step, the same for both agents but for the agent it names.
// Fletcher being unreachable, or having no review for the commit, is a
// notice; the wrong template for the repository's setting is an error.
const claimStep = (
  agent: RunnerAgent,
) => `      - name: Get the review from Fletcher
        id: claim
        env:
          PR: \${{ github.event.pull_request.number }}
          SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          dir="$RUNNER_TEMP/fletcher" && mkdir -p "$dir"
          oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$FLETCHER_AUDIENCE" | jq -r .value)
          body=$(jq -n --argjson pr "$PR" --arg sha "$SHA" \\
            '{pullRequestNumber: $pr, headSha: $sha, agent: "${agent}"}')
          # Fletcher may still be starting this review: wait up to a minute.
          for attempt in 1 2 3 4 5 6 7; do
            # Fletcher being unreachable is a notice, not a failed check.
            status=$(curl -sS -o "$dir/job.json" -w '%{http_code}' -X POST \\
              "$FLETCHER_URL/runner/v1/claim" -H "Authorization: Bearer $oidc" \\
              -H 'content-type: application/json' -d "$body") || status=unreachable
            [ "$status" = 200 ] && break
            code=$(jq -r '.error.code // empty' "$dir/job.json" 2>/dev/null || true)
            [ "$status" = 409 ] && [ "$code" = not_ready ] || break
            sleep 10
          done
          if [ "$code" = wrong_agent ]; then
            echo "::error::$(jq -r .error.message "$dir/job.json")"
            exit 1
          fi
          if [ "$status" != 200 ]; then
            echo "::notice::Fletcher has no review for this commit ($status $code)."
            exit 0
          fi
          jq -r .systemPrompt "$dir/job.json" > "$dir/system.md"
          jq -r .prompt "$dir/job.json" > "$dir/prompt.md"
          jq -c .schema "$dir/job.json" > "$dir/schema.json"
          {
            echo "job_id=$(jq -r .jobId "$dir/job.json")"
            echo "model=$(jq -r .model "$dir/job.json")"
            echo "effort=$(jq -r .effort "$dir/job.json")"
            echo "max_turns=$(jq -r .maxTurns "$dir/job.json")"
          } >> "$GITHUB_OUTPUT"`;

// Sends $report, built by the step before this, to Fletcher.
const sendReport = `          oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$FLETCHER_AUDIENCE" | jq -r .value)
          curl -sS --fail-with-body --retry 3 --retry-delay 5 -X POST \\
            "$FLETCHER_URL/runner/v1/jobs/$JOB/result" -H "Authorization: Bearer $oidc" \\
            -H 'content-type: application/json' -d "$report"`;

const checkoutStep = `      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
          persist-credentials: false`;

const reviewJobHeader = (origin: string) => `  review:
    # Forks get no secrets or OIDC token on pull_request, so they can't run.
    if: >-
      \${{ github.event_name == 'pull_request' &&
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: read
      id-token: write # Fletcher checks GitHub's OIDC token, not a secret
    env:
      FLETCHER_URL: ${origin}
      FLETCHER_AUDIENCE: ${RUNNER_OIDC_AUDIENCE}`;

export const runnerWorkflowYaml = (
  origin: string = SITE_URL,
) => `# .github/workflows/${RUNNER_WORKFLOW_FILE}
# Fletcher reviews each pull request with Claude Code on your Claude
# subscription. Needs the CLAUDE_CODE_OAUTH_TOKEN secret (claude setup-token).
name: Fletcher review

on:
  pull_request: # never pull_request_target
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: fletcher-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
${reviewJobHeader(origin)}
    steps:
${checkoutStep}

${claimStep("claude")}

      - name: Review with Claude Code
        id: claude
        if: steps.claim.outputs.job_id != ''
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
          MODEL: \${{ steps.claim.outputs.model }}
          MAX_TURNS: \${{ steps.claim.outputs.max_turns }}
        run: |
          dir="$RUNNER_TEMP/fletcher"
          npm install --global --loglevel=error @anthropic-ai/claude-code@${RUNNER_CLAUDE_CODE_VERSION}
          status=0
          claude -p \\
            --append-system-prompt-file "$dir/system.md" \\
            --output-format json \\
            --json-schema "$(cat "$dir/schema.json")" \\
            --tools "Read,Grep,Glob" \\
            --allowedTools "Read,Grep,Glob" \\
            --permission-mode dontAsk \\
            --max-turns "$MAX_TURNS" \\
            --model "$MODEL" \\
            --setting-sources user \\
            --strict-mcp-config \\
            --no-session-persistence \\
            < "$dir/prompt.md" > "$dir/result.json" || status=$?
          # Say why there is no review: Claude Code reports it on stdout.
          if [ "$status" -ne 0 ] || ! jq -e '.is_error == false and .structured_output != null' "$dir/result.json" > /dev/null; then
            reason=$(jq -r '[.subtype, .result] | map(select(. != null)) | join(": ")' \\
              "$dir/result.json" 2>/dev/null | tr '\\n' ' ' | head -c 400 || true)
            echo "::error::Claude Code produced no review (exit $status). \${reason:-It printed no result.}"
            exit 1
          fi

      - name: Send the review to Fletcher
        if: always() && steps.claim.outputs.job_id != ''
        env:
          JOB: \${{ steps.claim.outputs.job_id }}
          MODEL: \${{ steps.claim.outputs.model }}
          OUTCOME: \${{ steps.claude.outcome }}
        run: |
          dir="$RUNNER_TEMP/fletcher"
          if [ "$OUTCOME" = success ]; then
            report=$(jq -c --arg model "$MODEL" '{
              agent: "claude",
              outcome: "success",
              structuredOutput: .structured_output,
              model: ((.modelUsage // {} | keys | map(select(startswith($model))) | first) // (.modelUsage // {} | keys | first) // $model),
              inputTokens: ((.usage.input_tokens // 0) + (.usage.cache_read_input_tokens // 0) + (.usage.cache_creation_input_tokens // 0)),
              outputTokens: (.usage.output_tokens // null)
            }' "$dir/result.json")
          elif [ "$OUTCOME" = cancelled ]; then
            report='{"agent":"claude","outcome":"cancelled"}'
          else
            message=$(jq -r '.result // empty' "$dir/result.json" 2>/dev/null | head -c 400 || true)
            report=$(jq -n --arg m "\${message:-Claude Code failed. See the Actions log.}" \\
              '{agent: "claude", outcome: "failure", message: $m}')
          fi
${sendReport}
`;

// Codex reads its sign-in from $CODEX_HOME/auth.json. Both review and
// refresh jobs keep CODEX_HOME under RUNNER_TEMP, away from the checkout.
const codexInstall = `          export CODEX_HOME="$RUNNER_TEMP/codex-home"
          mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME"
          npm install --global --loglevel=error @openai/codex@${RUNNER_CODEX_VERSION}`;

export const codexRunnerWorkflowYaml = (
  origin: string = SITE_URL,
) => `# .github/workflows/${RUNNER_WORKFLOW_FILE}
# Fletcher reviews each pull request with Codex on your ChatGPT plan. Needs
# one secret: CODEX_ACCESS_TOKEN (Business and Enterprise), or
# CODEX_AUTH_JSON, your ~/.codex/auth.json (Plus and Pro), which also needs
# ${CODEX_AUTH_WRITE_TOKEN_SECRET} so the refresh job can keep it signed in.
name: Fletcher review

on:
  pull_request: # never pull_request_target
    types: [opened, synchronize, reopened, ready_for_review]
  schedule:
    - cron: "23 5 */3 * *" # refreshes CODEX_AUTH_JSON; see refresh-codex-sign-in
  workflow_dispatch:

concurrency:
  group: fletcher-review-\${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
${reviewJobHeader(origin)}
    steps:
${checkoutStep}

${claimStep("codex")}

      - name: Review with Codex
        id: codex
        if: steps.claim.outputs.job_id != ''
        timeout-minutes: ${CODEX_REVIEW_MINUTES}
        env:
          CODEX_ACCESS_TOKEN_SECRET: \${{ secrets.CODEX_ACCESS_TOKEN }}
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
          MODEL: \${{ steps.claim.outputs.model }}
          EFFORT: \${{ steps.claim.outputs.effort }}
        run: |
          dir="$RUNNER_TEMP/fletcher"
${codexInstall}
          if [ -n "$CODEX_ACCESS_TOKEN_SECRET" ]; then
            printenv CODEX_ACCESS_TOKEN_SECRET | codex login --with-access-token > /dev/null
          elif [ -n "$CODEX_AUTH_JSON" ]; then
            # Never written back from here: the refresh job owns rotation.
            printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
            chmod 600 "$CODEX_HOME/auth.json"
          else
            echo "::error::Set CODEX_ACCESS_TOKEN or CODEX_AUTH_JSON on this repository."
            exit 1
          fi
          unset CODEX_ACCESS_TOKEN_SECRET CODEX_AUTH_JSON
          # Read-only, and the sign-in unreadable: the "fletcher" profile
          # extends :read-only and denies CODEX_HOME. The pull request's
          # AGENTS.md is material to review, not instructions, so
          # project_doc_max_bytes=0 keeps Codex from loading it.
          status=0
          cat "$dir/system.md" "$dir/prompt.md" | codex exec - \\
            -c default_permissions='"fletcher"' \\
            -c permissions.fletcher.extends='":read-only"' \\
            -c "permissions.fletcher.filesystem={\\"$CODEX_HOME\\"=\\"none\\"}" \\
            -c shell_environment_policy.inherit='"core"' \\
            -c project_doc_max_bytes=0 \\
            --ephemeral \\
            --ignore-user-config \\
            --ignore-rules \\
            --json \\
            --output-schema "$dir/schema.json" \\
            -o "$dir/review.json" \\
            --model "$MODEL" \\
            -c model_reasoning_effort="$EFFORT" \\
            > "$dir/events.jsonl" || status=$?
          # Say why there is no review: Codex reports it as an event.
          if [ "$status" -ne 0 ] || ! jq -e . "$dir/review.json" > /dev/null 2>&1; then
            reason=$(jq -r 'select(.type == "turn.failed" or .type == "error") | .error.message // .message // empty' \\
              "$dir/events.jsonl" 2>/dev/null | tail -n 1 | head -c 400 || true)
            echo "::error::Codex produced no review (exit $status). \${reason:-It reported no error.}"
            exit 1
          fi

      - name: Send the review to Fletcher
        if: always() && steps.claim.outputs.job_id != ''
        env:
          JOB: \${{ steps.claim.outputs.job_id }}
          MODEL: \${{ steps.claim.outputs.model }}
          OUTCOME: \${{ steps.codex.outcome }}
        run: |
          dir="$RUNNER_TEMP/fletcher"
          if [ "$OUTCOME" = success ]; then
            # input_tokens already includes cached_input_tokens.
            usage=$(jq -sc 'map(select(.type == "turn.completed")) | last | .usage // {}' "$dir/events.jsonl")
            report=$(jq -c --arg model "$MODEL" --argjson usage "$usage" '{
              agent: "codex",
              outcome: "success",
              structuredOutput: .,
              model: $model,
              inputTokens: ($usage.input_tokens // null),
              outputTokens: ($usage.output_tokens // null)
            }' "$dir/review.json")
          elif [ "$OUTCOME" = cancelled ]; then
            report='{"agent":"codex","outcome":"cancelled"}'
          else
            message=$(jq -r 'select(.type == "turn.failed" or .type == "error") | .error.message // .message // empty' \\
              "$dir/events.jsonl" 2>/dev/null | tail -n 1 | head -c 400 || true)
            report=$(jq -n --arg m "\${message:-Codex failed. See the Actions log.}" \\
              '{agent: "codex", outcome: "failure", message: $m}')
          fi
${sendReport}

  # Keeps CODEX_AUTH_JSON signed in. Codex rotates a session older than
  # about 8 days, and the refresh token in the old copy then stops working,
  # so this job rotates it every 3 days and saves the new copy, before any
  # review would. It checks out nothing, so no pull request code runs
  # beside the write token. A no-op with CODEX_ACCESS_TOKEN.
  refresh-codex-sign-in:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions: {}
    concurrency:
      group: fletcher-codex-sign-in
      cancel-in-progress: false
    steps:
      - name: Refresh the Codex sign-in
        env:
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
          GH_TOKEN: \${{ secrets.${CODEX_AUTH_WRITE_TOKEN_SECRET} }}
          REPOSITORY: \${{ github.repository }}
        run: |
          if [ -z "$CODEX_AUTH_JSON" ]; then
            echo "::notice::No CODEX_AUTH_JSON secret, so there is nothing to refresh."
            exit 0
          fi
          if [ -z "$GH_TOKEN" ]; then
            echo "::error::Set ${CODEX_AUTH_WRITE_TOKEN_SECRET} so the refreshed sign-in can be saved."
            exit 1
          fi
${codexInstall}
          # Marking the session stale makes Codex rotate it on this run.
          printf '%s' "$CODEX_AUTH_JSON" \\
            | jq '.last_refresh = "2000-01-01T00:00:00Z"' > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"
          unset CODEX_AUTH_JSON
          codex exec --ephemeral --ignore-user-config --skip-git-repo-check \\
            --sandbox read-only "Reply with the single word OK." > /dev/null
          if ! jq -e '.auth_mode == "chatgpt" and .last_refresh > "2001"' "$CODEX_HOME/auth.json" > /dev/null; then
            echo "::error::Codex didn't refresh the sign-in. Run codex login and save a new CODEX_AUTH_JSON."
            exit 1
          fi
          gh secret set CODEX_AUTH_JSON --repo "$REPOSITORY" < "$CODEX_HOME/auth.json"
`;

/** The workflow template for an agent. */
export const runnerWorkflowYamlFor = (
  agent: RunnerAgent,
  origin: string = SITE_URL,
) =>
  agent === "claude"
    ? runnerWorkflowYaml(origin)
    : codexRunnerWorkflowYaml(origin);

import {
  RUNNER_OIDC_AUDIENCE,
  RUNNER_WORKFLOW_FILE,
} from "../application/runner-jobs.js";
import { SITE_URL } from "./components.js";

// The workflow a repository commits to review on its owner's Claude
// subscription. It must stay in step with apps/api/src/application/
// runner-jobs.ts: the claim and result bodies and the bundle's fields.
//
// Claude Code runs as the unmodified CLI, not claude-code-action: the
// action passes its prompt through the environment, and a large pull
// request's prompt fails with "Argument list too long". The token lives in
// the review step's environment only, and --setting-sources user keeps the
// pull request's own .claude/settings.json (and its hooks) from loading.

/** Pinned so flags and output don't change under a repository. */
export const RUNNER_CLAUDE_CODE_VERSION = "2.1.318";

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
  review:
    if: \${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: read
      id-token: write # Fletcher checks GitHub's OIDC token, not a secret
    env:
      FLETCHER_URL: ${origin}
      FLETCHER_AUDIENCE: ${RUNNER_OIDC_AUDIENCE}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
          persist-credentials: false

      - name: Get the review from Fletcher
        id: claim
        env:
          PR: \${{ github.event.pull_request.number }}
          SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          dir="$RUNNER_TEMP/fletcher" && mkdir -p "$dir"
          oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$FLETCHER_AUDIENCE" | jq -r .value)
          body=$(jq -n --argjson pr "$PR" --arg sha "$SHA" '{pullRequestNumber: $pr, headSha: $sha}')
          # Fletcher may still be starting this review: wait up to a minute.
          for attempt in 1 2 3 4 5 6 7; do
            status=$(curl -sS -o "$dir/job.json" -w '%{http_code}' -X POST \\
              "$FLETCHER_URL/runner/v1/claim" -H "Authorization: Bearer $oidc" \\
              -H 'content-type: application/json' -d "$body")
            [ "$status" = 200 ] && break
            code=$(jq -r '.error.code // empty' "$dir/job.json" 2>/dev/null || true)
            [ "$status" = 409 ] && [ "$code" = not_ready ] || break
            sleep 10
          done
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
            echo "max_turns=$(jq -r .maxTurns "$dir/job.json")"
          } >> "$GITHUB_OUTPUT"

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
          npm install --global --silent @anthropic-ai/claude-code@${RUNNER_CLAUDE_CODE_VERSION}
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
            < "$dir/prompt.md" > "$dir/result.json"
          jq -e '.is_error == false and .structured_output != null' "$dir/result.json" > /dev/null

      - name: Send the review to Fletcher
        if: always() && steps.claim.outputs.job_id != ''
        env:
          JOB: \${{ steps.claim.outputs.job_id }}
          MODEL: \${{ steps.claim.outputs.model }}
          OUTCOME: \${{ steps.claude.outcome }}
        run: |
          dir="$RUNNER_TEMP/fletcher"
          oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$FLETCHER_AUDIENCE" | jq -r .value)
          if [ "$OUTCOME" = success ]; then
            report=$(jq -c --arg model "$MODEL" '{
              outcome: "success",
              structuredOutput: .structured_output,
              model: $model,
              inputTokens: ((.usage.input_tokens // 0) + (.usage.cache_read_input_tokens // 0) + (.usage.cache_creation_input_tokens // 0)),
              outputTokens: (.usage.output_tokens // null)
            }' "$dir/result.json")
          elif [ "$OUTCOME" = cancelled ]; then
            report='{"outcome":"cancelled"}'
          else
            message=$(jq -r '.result // empty' "$dir/result.json" 2>/dev/null | head -c 400 || true)
            report=$(jq -n --arg m "\${message:-Claude Code failed. See the Actions log.}" \\
              '{outcome: "failure", message: $m}')
          fi
          curl -sS --fail-with-body --retry 3 --retry-delay 5 -X POST \\
            "$FLETCHER_URL/runner/v1/jobs/$JOB/result" -H "Authorization: Bearer $oidc" \\
            -H 'content-type: application/json' -d "$report"
`;

# Progress Tracker

Companion to [PLAN.md](./PLAN.md). This is the handoff document: if you are an
agent (or human) picking this project up cold, read PLAN.md for the "why",
then this file for exactly where things stand and what to do next.

## How to use this file

- Every task is a checkbox. Check it off in the same change that lands it.
- Each phase ends with a **Handoff notes** block: decisions made, deviations
  from the plan, and the exact next task to start.
- Verify before checking anything off: `pnpm lint` → `pnpm format:check` →
  `pnpm typecheck` → `pnpm typecheck:test` → `pnpm build` → `pnpm test`.

## Status at a glance

| Phase | Description               | Status        |
| ----- | ------------------------- | ------------- |
| 1     | GitHub App authentication | ✅ Done       |
| 2     | Fetch the PR diff         | ✅ Done       |
| 3     | Gemini review service     | ✅ Done       |
| 4     | Wire the Workflow         | ✅ Done       |
| 5     | Post the review to GitHub | ✅ Done       |
| 6     | Hardening & operations    | 🟡 Core done  |
| 7     | Findings memory           | ✅ Done       |
| 8     | `/fletcher again` command | ✅ Done       |
| 9     | `.fletcher.json` + guard  | ✅ Done       |
| 10    | Read API + GitHub OAuth   | ✅ Done       |
| 11    | Dashboard UI              | 🟡 v1 shipped |
| 12    | Accounts & authorization  | 🟡 Partial    |
| 13    | GitHub onboarding         | ✅ Core done  |
| 16    | BYOK, trial, billing      | ⬜ Planned    |

**Next task:** workspaces and memberships (Phase 12): a workspace per
GitHub account/org installation, owner/admin/member roles, and restricting
repository toggles to admins. Then Phase 14 dashboard management. See
PLAN.md "Recommended order".

### Onboarding flow — 2026-09-28

- `/` is a landing page (signed-in visitors redirect to `/dashboard`); the
  service-metadata JSON moved off the root.
- `/onboarding`: install link (`GITHUB_APP_SLUG`), repository list with
  on/off toggles, and first-review guidance.
- `/onboarding/callback` (GitHub Setup URL) holds `installation_id` in a
  10-minute cookie and re-runs sign-in; the OAuth callback syncs it only if
  it appears in the user's `/user/installations`, and also syncs any
  visible installations not yet stored. Sync failures are logged and do not
  block sign-in. `setup_action=request` shows a pending-approval page.
- Sign-in redirects to `/onboarding` when requested (`/auth/login?next=
onboarding`, allowlisted) or when the user has no repositories.
- `POST /onboarding/repositories/:id` toggles `repositories.enabled`
  (same-origin check, session repository access). Any user with GitHub
  access to the repository can toggle it until Phase 12 adds roles.

### Installation sync — 2026-09-28

- `installation` (created/unsuspend/new_permissions_accepted) and
  `installation_repositories` (added/removed) deliveries reconcile stored
  repositories against `GET /installation/repositories`
  (`apps/api/src/application/installation-sync.ts`).
- `suspend` marks the installation `suspended`; `deleted` marks it
  `removed` and sets `removed_at` on all its repositories. History is kept.
- Migration `0003` adds `github_installations.status` and
  `repositories.removed_at`. Pull request deliveries never change either,
  so a late webhook cannot revive access.
- `handleReviewRequest` skips (`ignored`) inactive installations, removed
  repositories, and repositories with `enabled = false` (previously
  unenforced). The read API and dashboard hide removed repositories.

### Active priorities (2026-09-18)

- [ ] Phase 12: accounts, sessions, workspace roles, and repository access
      enforcement, including permission removal and isolation tests.
- [ ] Phase 13: verified GitHub installation linking, repository sync,
      installation lifecycle handling, and self-service onboarding.
- [ ] Phase 14: dashboard correctness, review summaries, GitHub links,
      pagination, accessible responsive UI, and repository settings.
- [ ] Phase 15: recovery, monitoring, operational usage limits, deletion and
      retention, production configuration, and full release verification.

Detailed scope and acceptance criteria are in the active roadmap at the top
of [PLAN.md](./PLAN.md). Plans, billing, subscriptions, checkout, and paid
entitlements are deferred outside the current focus. Usage tracking and
operational rate limits remain in scope for abuse and cost control.

The OAuth redirect defect is fixed with regression coverage in Phase 12.
Comment-ID persistence, misleading success messages, and layout overflow
remain open for Phase 14. The manual test report remains the source for
pending live checks and the credential rotation prerequisite. Production
secrets, callback/webhook configuration, Issue comment subscription, and
remote migrations must be verified before release.

### Phase 12 foundation — completed 2026-09-18

- [x] Persistent users keyed by immutable GitHub ID, with mutable login
      updates, exposed through authenticated `GET /api/me`.
- [x] Opaque, one-hour sessions stored as keyed token hashes in D1; sign-in
      rotates the current session and logout revokes it server-side.
- [x] Paginated GitHub repository access discovery, enforced on dashboard and
      API reads; installation membership alone no longer grants repository
      access. Large grants use parameterized JSON queries to avoid D1 bind
      limits.
- [x] OAuth success returns to `/dashboard`; denied/failed login is handled,
      auth URLs are omitted from request logging, and private responses are
      not cached. Logout requires a same-origin POST.
- [x] Migration `0002_good_metal_master.sql` adds users/sessions; existing
      review data remains intact, and old cookie-only sessions require a new
      sign-in. Applied successfully to local D1; remote migration is pending.
- [x] Verification: lint, formatting, application and test typechecks,
      Wrangler dry-run build, and all 123 tests across 16 files passed.
      Coverage includes username changes, hashed storage, expiry/revocation,
      cross-origin logout, same-installation repository isolation, pagination,
      and OAuth failures. Two independent integration reviews found no
      additional in-scope defects.

Permission grants remain a sign-in snapshot with a one-hour maximum lifetime.
Immediate GitHub permission revocation, workspace roles/ownership, installation
linking, and onboarding are not implemented by this slice. Billing remains
deferred. Live browser/GitHub OAuth verification of the updated flow and a
production deploy have not been performed. Verification used installed Node
26.8.2 and pnpm 11.1.3; the pinned Node 26.7.0 is not installed locally.

### Pre-commit review — 2026-09-28

- Reviewed account persistence, OAuth, session rotation/revocation,
  repository access checks, migration, and regression coverage; no blocking
  defects found in this slice. Corrected stale roadmap and migration notes.
- Lint, formatting, dry-run build, application/test typechecks, and all 123
  tests across 16 files passed using Node 26.9.0 and pnpm 11.1.3. The initial
  sandboxed test run could not bind loopback ports; the permitted rerun passed.
- Live OAuth/browser verification and remote migration remain pending.

---

## Phase 1 — GitHub App authentication ✅

- [x] `apps/api/src/github/app-auth.ts`: `GitHubAppAuth` Effect service
      (`Context.Tag`) with `mintInstallationToken(installationId)`.
- [x] RS256 App JWT signed via WebCrypto (`importKey("pkcs8", ...)` +
      `crypto.subtle.sign`) — workerd-safe, no Node crypto, no Octokit.
      Claims: `iat = now - 60s`, `exp = now + 540s` (under GitHub's 10-minute
      cap), `iss = appId`. Clock read through Effect's `Clock` service.
- [x] PKCS#1 PEMs (`BEGIN RSA PRIVATE KEY`, GitHub's download format) are
      rejected with a clear error telling you to convert to PKCS#8.
- [x] Installation token exchange:
      `POST /app/installations/{id}/access_tokens`, decoding
      `{ token, expires_at }` into `{ token, expiresAt: Date }` via Effect
      `Schema`. Tagged errors: `GitHubAppJwtError`,
      `GitHubApiRequestError`, `GitHubInstallationTokenError`.
- [x] Layer `GitHubAppAuthLive(config)` takes `appId`, `privateKey`, and
      optional `baseUrl` / `fetchImpl` for dependency-injected tests (module
      mocking is banned by the anti-slop lint rules).
- [x] Confirmed `installationId` reaches the Workflow: it is a field of
      `ReviewRequest`, which is embedded in `ReviewWorkflowParams.request`.
      No change needed.
- [x] Tests in `apps/api/test/github-app-auth.test.ts`: JWT claim contents
      and signature verification against a generated keypair, token exchange
      request shape (URL, method, `Bearer` header, API version header),
      non-2xx failure, malformed response body failure, PKCS#1 rejection.
- [x] `.env.example`: documented `GITHUB_APP_ID` and
      `GITHUB_APP_PRIVATE_KEY` (incl. PKCS#8 conversion command).
- [x] README: new "GitHub App credentials" section with local `.dev.vars`
      and production `wrangler secret put` instructions.

### Handoff notes (Phase 1)

- The secrets are documented but **not yet read by any Worker code** — the
  `Bindings` type in `apps/api/src/index.ts` and the Workflow env in
  `apps/api/src/workflows/review-pull-request.ts` are intentionally
  untouched. Wiring happens in Phase 4 when a Workflow step first consumes
  `GitHubAppAuth`. Do not add unused bindings before then.
- Tokens are minted per Workflow run (valid 1 h); no caching in v1 by design.
- `fetchImpl` injection is the established testing pattern for all outbound
  HTTP in this repo — reuse it for the Phase 2 PR client and Phase 3 Gemini
  client.
- **Start next:** Phase 2. The PR client should depend on `GitHubAppAuth`
  (take the token as an argument or compose the services — decide when
  writing it; keep the diff parser pure and in `packages/core`).

## Phase 2 — Fetch the PR diff ✅

- [x] `apps/api/src/github/pull-request-client.ts`: `GitHubPullRequestClient`
      Effect service with `fetchDiff` (`Accept: application/vnd.github.diff`)
      and `fetchDetails` (JSON metadata → `{ title, body, baseRef, baseSha,
headSha }` via `Schema` decode). Tagged errors:
      `PullRequestRequestError`, `PullRequestResponseError`,
      `PullRequestDiffTooLargeError`.
- [x] Diff size cap: `maxDiffBytes` config, default 300 000 bytes; overflow
      fails with `PullRequestDiffTooLargeError { sizeBytes, maxDiffBytes }`
      so Phase 4 can mark the run `diff_too_large` instead of failed.
- [x] Pure, total (lenient) diff parser in `packages/core/src/diff.ts`:
      `parseUnifiedDiff` produces per-file status
      (added/modified/removed/renamed), previous path for renames, and
      per-line old/new line numbers for review-comment anchoring. Handles
      `\ No newline` markers, empty context lines, and trailing newline at
      EOF. Re-exported from `packages/core/src/index.ts`.
- [x] Default ignore list in core: `isIgnoredDiffPath` /
      `reviewableDiffFiles` (lockfiles, `*.min.*`, `drizzle/**` migrations,
      `worker-configuration.d.ts`, binary assets, snapshots).
- [x] Fixture `apps/api/test/fixtures/pull-request.diff` (modified, added,
      deleted, renamed, lockfile; imported via Vite `?raw` — typed by the
      `vite/client` types already in `test/tsconfig.json`).
- [x] Tests: `apps/api/test/diff.test.ts` (parser + filtering, 9 tests) and
      `apps/api/test/pull-request-client.test.ts` (request shape, size cap,
      non-2xx, schema mismatch, 5 tests).

### Handoff notes (Phase 2)

- **Decision:** the client takes the installation token as a plain argument
  instead of depending on `GitHubAppAuth`. Token minting is its own durable
  Workflow step in Phase 4, so composing the services here would hide the
  step boundary.
- The parser lives in `packages/core` and is deliberately dependency-free of
  the client; Phase 4 composes `fetchDiff` → `parseUnifiedDiff` →
  `reviewableDiffFiles`.
- Parser is lenient/total by design (skips unknown metadata lines) — do not
  add failure modes for malformed diffs; GitHub's output is the source.
- `pnpm test` must run **unsandboxed** in agent environments: workerd binds
  `127.0.0.1`, which terminal sandboxes typically block.
- **Start next:** Phase 3 — `packages/gemini`. Reuse the `fetchImpl`
  injection pattern; keep the package platform-neutral (no Worker types).

## Phase 3 — Gemini review service ✅

- [x] New workspace package `packages/gemini` (exports `.` → `src/index.ts`,
      no build step, `effect` only dependency; added to `apps/api` as
      `workspace:*`; lockfile updated).
- [x] `fetch`-based transport to `/v1beta/models/{model}:generateContent`
      with `x-goog-api-key` header; default model `gemini-3.8-flash`
      (`DEFAULT_GEMINI_MODEL`), configurable via `GeminiReviewerConfig.model`.
- [x] Structured output: `generationConfig.responseSchema`
      (`geminiResponseJsonSchema`) + `responseMimeType: application/json`;
      candidate text decodes into `GeminiReview` / `GeminiFinding` Effect
      schemas mirroring the `findings` table. Temperature pinned to 0.2.
- [x] `GeminiReviewer` service (`packages/gemini/src/reviewer.ts`): tagged
      errors (`GeminiRequestError`, `GeminiResponseError`,
      `GeminiResponseParseError`, `GeminiTimeoutError`), per-attempt
      `Effect.timeoutFail` (default 60 s), retry via jittered
      `Schedule.exponential` ∩ `Schedule.recurs` gated by a `Match`-based
      retry predicate (429/5xx/network/timeout only).
- [x] Fletcher system prompt (`packages/gemini/src/prompt.ts`) with hard
      guardrails (code not people, concrete fixes mandatory, honest
      verdicts) and `buildReviewUserPrompt` for the PR context + fenced diff.
- [x] Result includes `usage` (token counts from `usageMetadata`, nullable)
      and `model` for Phase 6 cost logging.
- [x] 9 tests in `apps/api/test/gemini-reviewer.test.ts`: request shape,
      decode, missing usage, 429-then-success retry, no retry on 400, retry
      exhaustion on 503, parse failure, timeout, golden schema + prompt
      guardrail checks.
- [x] `.env.example` + README updated for `GEMINI_API_KEY` / `GEMINI_MODEL`.

### Handoff notes (Phase 3)

- Tests inject `retryBaseMillis: 1` to keep retry tests fast; the live
  default is 500 ms base with jitter.
- The golden test pins prompt guardrail phrases ("never the author",
  "concrete, technically correct", "good_job") — keep them (or update the
  test deliberately) when revising the persona.
- `geminiResponseJsonSchema` must stay in sync with the Effect schemas by
  hand; the golden test only covers the Effect side.

## Phase 4 — Wire the Workflow ✅

- [x] `WorkflowEnv` now includes `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
      `GEMINI_API_KEY`, optional `GEMINI_MODEL`; layers built in
      `ReviewPullRequestWorkflow.run` (`GitHubAppAuthLive`,
      `GitHubPullRequestClientLive`, `GeminiReviewerLive`, `makeLiveLayer`).
- [x] `performFakeReview()` removed. Durable steps: mark running → mint
      installation token → fetch pull request (details + filtered diff) →
      run gemini review → persist findings → mark completed.
- [x] `packages/db/src/repositories/finding-repository.ts`: `insertMany`
      (no-op on empty), `listByReviewRun`, `setGithubCommentId`; added to
      `makeLiveLayer` and db exports. `ReviewRunRepository.setModel` added.
- [x] Findings persist before any GitHub posting; steps memoize so a failed
      later step never re-bills Gemini.
- [x] Error taxonomy via `reviewErrorCode` (`Match.exhaustive` over the
      `ReviewPipelineError` union) → `github_auth_error`, `diff_fetch_error`,
      `diff_too_large`, `gemini_error`, `db_error`, `review_run_not_found`,
      plus `workflow_error` for infrastructure failures.
- [x] `runStep` outcome encoding: non-retryable pipeline failures are
      _persisted step output_ (`StepOutcome`) surfaced as `ReviewStepFailure`
      with the error code; retryable failures (GitHub 429/5xx/network, D1
      errors) reject the step promise so Cloudflare's step retry policy
      re-runs them.
- [x] `filterUnifiedDiff` added to `packages/core` (drops ignored file
      blocks from the raw diff text before Gemini sees it).
- [x] Structured logging: `review_workflow_completed` now includes verdict,
      findingCount, and model; failures log `errorCode`.
- [x] No schema migration needed — `model`, `error_code`, and the whole
      `findings` table already existed in migration `0000_*`.
- [x] README updated (real pipeline description, `.dev.vars` example with
      all four values, error code list).

### Handoff notes (Phase 4)

- **Deviation from PLAN.md:** oversized diffs mark the run **failed** with
  `error_code = diff_too_large` (no Fletcher "band this size" comment yet).
  Revisit in Phase 5/6 if a posted comment is wanted; the typed error is
  already distinct.
- Per-step timing fields were skipped (Cloudflare's Workflow dashboard
  already exposes step durations); only per-run structured events are logged.
- If a retryable failure exhausts Cloudflare's step retries, the run is
  marked failed with `workflow_error` (the original message is preserved in
  `error_message`); the fine-grained code only survives for non-retryable
  failures. Known tradeoff of the outcome encoding.
- The installation token is returned from the `mint installation token`
  step, so it is persisted in Workflow state for up to its 1 h validity.
  Acceptable for v1; revisit if that changes.
- **Start next:** Phase 5 — `createReview` on the PR client + a
  `post github review` step between persist and complete, wiring
  `findings.github_comment_id` via `FindingRepository.setGithubCommentId`.

## Phase 5 — Post the review to GitHub ✅

- [x] `createReview` on `GitHubPullRequestClient`:
      `POST /repos/{owner}/{repo}/pulls/{number}/reviews`, always
      `event: COMMENT`, `commit_id = headSha`, inline comments with `path` +
      `line` + `side: RIGHT`. New tagged errors `ReviewSubmitRequestError` /
      `ReviewSubmitResponseError` → error code `post_review_error`.
- [x] `listReviewComments` fetches the posted comments; IDs are matched back
      to findings by (path, line, exact body) and written to
      `findings.github_comment_id`.
- [x] Anchoring: `commentableLinesByFile` in `packages/core` collects added
      lines' new-file numbers; findings that don't anchor fold into an "Off
      the chart" section of the summary body instead of being dropped.
- [x] Fletcher presentation in
      `apps/api/src/application/review-presentation.ts`: verdict headings
      (🥁 "Not quite my tempo." / "Almost. Almost." / "...Good job."),
      severity counts, per-finding comment bodies (title, message,
      severity + confidence footer).
- [x] Workflow step `post github review` between `persist findings` and
      `mark review run completed`; completion log includes `githubReviewId`
      and `inlineCommentCount`.
- [x] Tests: client createReview/listReviewComments request shape + decode +
      422 error; `postReviewToGitHub` integration test with a stubbed client
      layer over real D1 (anchored vs folded findings, comment ID
      write-back).

### Handoff notes (Phase 5)

- **Decision:** review submission errors are non-retryable at the step level
  (creating a review is not idempotent; a retry after an ambiguous network
  failure could double-post). The run fails with `post_review_error` and
  findings remain persisted for manual redelivery.
- Comment-ID matching relies on exact body equality; if GitHub ever
  normalizes comment bodies, unmatched findings simply keep
  `github_comment_id = NULL` (no failure).
- `GET /reviews/{id}/comments` is unpaginated here — fine while reviews stay
  under 30 inline comments (the prompt pushes for few findings); paginate if
  that assumption breaks.
- **Manual end-to-end verification (tunnel + real GitHub App + real Gemini
  key) has not been run.** Do it before or at the start of Phase 6; the
  README's local-webhook section documents the full flow.

## Phase 6 — Hardening & operations 🟡

- [x] Per-installation daily run cap (`DAILY_REVIEW_RUN_CAP = 50`, rolling
      24 h via `Clock`): checked in `handleReviewRequest` after the upserts
      and before `createOrFind`; over-cap deliveries log
      `review_rate_limited` and return `{ status: "rate_limited" }` (HTTP 202
      — GitHub should not retry). Backed by
      `ReviewRunRepository.countForInstallationSince` (join through
      `repositories`). Cap is a defaulted parameter for testability.
- [x] Token usage on the run row: migration
      `0001_abandoned_lorna_dane.sql` adds `input_tokens`, `output_tokens`,
      `total_tokens` to `review_runs`; `setModel` was replaced by
      `recordModelUsage(id, model, usage)`, called from
      `persistReviewFindings`. `apps/api/test/setup.ts` extended to apply
      both migrations (it hardcodes the list — extend again for `0002_*`).
- [ ] Stretch: `.fletcher.json` repo config (severity threshold, ignore
      globs, persona intensity).
- [x] Stretch: `/fletcher again` issue-comment command — done as Phase 8.
- [ ] Stretch: prior-findings memory on `synchronize`.
- [x] Manual end-to-end verification with a real GitHub App + Gemini key
      (performed 2026-09-14: live webhook → Workflow → Gemini → posted
      review confirmed).
      private-repository PR webhook delivery, durable Workflow execution,
      Gemini structured review, summary and inline GitHub comments, D1
      findings/model/token persistence, and duplicate delivery handling.

### Handoff notes (Phase 6, core)

- Rate-limited deliveries intentionally return 202 (not 429) so GitHub marks
  the delivery successful; the signal lives in the response body and the
  `review_rate_limited` log event.
- The cap counts _runs created_, including failed ones — a stuck integration
  can't burn Gemini spend by failing repeatedly past the cap.
- Remote deploys now require `pnpm db:migrate:remote` for `0001_*` before
  shipping this code.

## Phase 7 — Findings memory on `synchronize` ✅

- [x] `ReviewRunRepository.findLatestCompletedForPullRequest` (repository,
      PR number, excluded run ID) — latest **completed** prior run only
      (failed runs never shadow a completed review).
- [x] `loadPriorReview(reviewRunId)` in
      `apps/api/src/application/review-workflow.ts`: resolves the current
      run → prior completed run → slims its findings to
      `PriorFinding { filePath, line, severity, title, message }`; returns
      `PriorReview | null` (serializable).
- [x] `GeminiReviewInput.priorReview: PriorReview | null` (breaking change,
      all call sites updated). User prompt gains a "Previous review (commit
      …)" section — including an explicit "no findings were raised" variant
      for clean prior reviews. System prompt gains a MEMORY block:
      acknowledge fixes grudgingly in the summary, don't re-raise unchanged
      findings verbatim, escalate severity one level on repeat offenses.
- [x] New durable Workflow step `load prior findings` between
      `fetch pull request` and `run gemini review`.
- [x] No schema changes.
- [x] Tests: prompt section rendering (with/without/empty prior review),
      MEMORY guardrail pinned in the golden test, and three D1 integration
      tests for `loadPriorReview` (no prior, latest-completed selection with
      a failed run in between, other-PR isolation). 63 tests total.

### Handoff notes (Phase 7)

- Only the **single most recent completed** prior review is fed to the
  prompt, by design — full history is noise and token spend. Revisit only if
  repeat-offense escalation proves too forgetful across 3+ pushes.
- The `opened` trigger also benefits: a reopened PR (new run after a
  completed one) gets memory for free.
- Escalation happens in the model via prompt rules, not in code — there is
  no programmatic severity bump. Keep it that way unless evals show the
  model ignores the MEMORY rules.
- **Start next:** `/fletcher again` (see "Next task" at the top).

## Phase 8 — `/fletcher again` comment command ✅

- [x] `ReviewRequest.trigger` widened to include `manual`
      (`ReviewRequestTrigger`); the pull_request webhook transform stays
      narrow via an internal `WebhookReviewRequest` struct (webhooks can
      never decode to `manual`).
- [x] `apps/api/src/github/manual-command.ts`: `decodeIssueCommentBody`
      decodes `issue_comment` deliveries; only `created` comments starting
      with `/fletcher again` (case-insensitive, trimmed) on actual pull
      requests (`issue.pull_request` present) produce a command — everything
      else is `None`/ignored, never a 400.
- [x] `handleManualReviewCommand` in `review-requests.ts`: mints an
      installation token, resolves the current head SHA via `fetchDetails`,
      then funnels into `handleReviewRequest` with `trigger: "manual"` — so
      idempotency (`already_processed` for an already-reviewed SHA) and the
      daily cap both apply unchanged.
- [x] Webhook routing: `issue_comment` arm in `processGitHubWebhook`; the
      route in `index.ts` now provides `GitHubAppAuthLive` +
      `GitHubPullRequestClientLive` (Bindings gained `GITHUB_APP_ID` /
      `GITHUB_APP_PRIVATE_KEY`).
- [x] README: command documented; webhook setup steps now say to subscribe
      to issue comment events.
- [x] Tests: decoder (command / ordinary comment / non-PR issue) and a full
      `handleManualReviewCommand` integration test with stub auth + client +
      workflow layers over real D1 (verifies `manual` trigger and resolved
      head SHA). 67 tests total.

### Handoff notes (Phase 8)

- **Operational prerequisite:** the GitHub App must be subscribed to
  **Issue comment** events (and have Pull requests read/write + Issues read
  permissions) or the command silently never arrives.
- Malformed or irrelevant `issue_comment` payloads are ignored (200-path),
  by design — only `pull_request` payloads with supported actions can
  produce a 400.
- No permission check on who commented: anyone who can comment on the PR
  can trigger a re-review. The daily cap is the only brake. Consider
  restricting to collaborators (`author_association` field) as a follow-up.
- Errors during head-SHA resolution (auth/API failures) surface as 500s on
  the webhook delivery — visible in GitHub's delivery log, retryable via
  GitHub's redeliver button.
- ~~No permission check on who commented~~ — fixed in Phase 9
  (`author_association` guard).

## Phase 9 — `.fletcher.json` config + command guard ✅

- [x] `packages/core/src/review-config.ts`: `ReviewConfig` schema with
      defaults (`enabled: true`, `severityThreshold: "suggestion"`,
      `ignore: []`, `intensity: "studio_band"`), `defaultReviewConfig`,
      `REVIEW_CONFIG_PATH`.
- [x] `globToRegExp` in core (`**` crosses directories, `*`/`?` do not;
      metacharacters escaped); `filterUnifiedDiff` accepts extra ignore
      globs merged with the built-in list.
- [x] `GitHubPullRequestClient.fetchRepositoryFile` — contents API with
      `Accept: application/vnd.github.raw+json` at `ref=headSha`; 404 →
      `Option.none`.
- [x] `fetchReviewablePullRequest` resolves the config (malformed file →
      `invalid_review_config` log + defaults, never a failure) and applies
      ignore globs to the diff; returns `config` alongside details + diff.
- [x] `enabled: false` → Workflow marks the run completed and logs
      `review_skipped_disabled` before any Gemini/GitHub calls.
- [x] `intensity` → `buildSystemPrompt(intensity)` in `packages/gemini`
      (`sectional` / `studio_band` = base prompt / `carnegie`);
      `severityThreshold` → `filterReviewBySeverity` applied inside the
      memoized review step so persist + post stay consistent.
- [x] `/fletcher again` now requires `comment.author_association` ∈
      {OWNER, MEMBER, COLLABORATOR}.
- [x] Tests: config resolution (absent/malformed/applied globs), glob
      semantics, severity filtering, intensity prompt variants, contents-API
      client (raw fetch / 404 / 403), non-collaborator command rejection.
      81 tests total.

### Handoff notes (Phase 9)

- A disabled repo still **creates a run row** (status `completed`, zero
  findings) — deliberate, so the daily-cap math and audit trail stay simple.
- `severityThreshold` filtering happens inside the `run gemini review` step,
  _after_ the model call — the model still sees and weighs everything; the
  threshold only gates persistence/posting. Verdict is not recomputed.
- The config is read at the PR's **head SHA** — a PR can change its own
  review config. Acceptable for now; pin to the default branch if it gets
  abused.
- `ReviewIntensity` literal union is duplicated in `packages/gemini`
  (dependency-free by design) — keep the two in sync.
- Note: `postReviewToGitHub` gained a short poll (3 × 250 ms) for
  `listReviewComments` eventual consistency — added by the user during live
  e2e testing; preserved.
- **Start next:** Phase 10 — read API + GitHub OAuth (PLAN.md has the
  design).

## Phase 10 — Read API + GitHub OAuth ✅

- [x] Session module (`apps/api/src/auth/session.ts`): HMAC-SHA256-signed
      cookie (`nqmt_session`, 7-day TTL) carrying
      `{ login, installationIds, expiresAt }`. `verifySession` resolves any
      failure (bad signature, expiry, malformed, missing secret) to `None`.
- [x] OAuth service (`apps/api/src/auth/github-oauth.ts`): `GitHubOAuth`
      Effect service with `exchangeCode`, `fetchUserLogin`,
      `fetchUserInstallationIds` (fetch-injected, tagged errors).
- [x] Routes: `GET /auth/login` (random `state` in a short-lived cookie →
      GitHub authorize URL), `GET /auth/callback` (state check → code
      exchange → installations → session cookie → redirect `/`),
      `GET /auth/logout`.
- [x] Read API (`apps/api/src/application/read-api.ts` + routes):
      `/api/repositories`, `/api/repositories/:id/runs` (latest 25),
      `/api/runs/:id/findings`, `/api/usage` (per-repo run counts + token
      sums). Authorization by joining the session's GitHub installation IDs;
      unknown and inaccessible both return 404 (`ResourceNotFoundError`) to
      prevent ID enumeration. No session → 401.
- [x] DB additions: `GitHubRepositoryRepository.listByGithubInstallationIds`
      / `findByIdWithGithubInstallationId`;
      `ReviewRunRepository.listByRepository` / `usageByRepositoryIds`
      (grouped `coalesce(sum(...))`).
- [x] `POST /debug/review-runs` **removed** (was unauthenticated write
      access; the read API + real pipeline replace it). README section
      replaced with API/auth docs.
- [x] New secrets documented in `.env.example` + README:
      `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
      `SESSION_SECRET` (rotating it signs everyone out).
- [x] Tests (98 total): session round-trip/tamper/expiry/missing-secret,
      OAuth service request shapes + failure, read-API authorization over
      real D1, route-level 401/403-as-404/login-redirect/state-mismatch.

### Handoff notes (Phase 10)

- Session authorization is **point-in-time**: installation access is
  captured at login and lives for the cookie's 7 days. Revoked access
  persists until logout/expiry. Acceptable for v1; re-validate on a shorter
  TTL if it matters.
- The OAuth client credentials come from the **same GitHub App** (its OAuth
  "Client ID" + generated client secret) — no separate OAuth App. The App's
  callback URL must be `<worker-url>/auth/callback`.
- `withSession` in `index.ts` is the auth gate for all `/api/*` routes —
  reuse it for the Phase 11 HTML routes.
- Cookies are `Secure`; for local `http://localhost:8787` testing use the
  Wrangler tunnel (`t`) or a browser that allows secure cookies on
  localhost (Chrome does).
- **Start next:** Phase 11 — dashboard UI.

## Phase 11 — Dashboard UI 🟡 (functional v1, not "done")

- [x] Server-rendered views in `apps/api/src/dashboard/views.ts` using
      `hono/html` tagged templates (auto-escaping; deviation from PLAN's
      "Hono JSX" — same zero-build ergonomics without tsconfig/JSX tooling
      changes). Dark monospace theme, brass accent, 🥁 branding.
- [x] Routes on the same Worker, gated by `withSessionPage` (signed-out →
      landing page with "Sign in with GitHub", not a 401):
      `/dashboard` (repositories + run counts + token usage),
      `/dashboard/repositories/:id` (latest runs: PR, trigger, status,
      error code, model, tokens, created), `/dashboard/runs/:id` (findings:
      severity, location, title/message, confidence, GitHub comment ID; a
      clean run says "No findings. ...Good job.").
- [x] Inaccessible/unknown resources render a themed 404 page ("Not my
      chart.").
- [x] Tests (`apps/api/test/dashboard.test.ts`): landing page when signed
      out, usage table, runs table, findings table, cross-installation 404.
      103 tests total.

### Handoff notes (Phase 11)

- `c.html` returns `Response | Promise<Response>`; `withSessionPage`
  flattens with a final `.then(Promise.resolve)` — keep that if adding
  routes.
- Views take db row types (`ReviewRun`, `Finding`, `GitHubRepository`)
  directly; interpolations are auto-escaped by `hono/html`. Never
  interpolate with `raw()` for user-controlled strings.
- The root `/` still returns service JSON (tests pin it); the dashboard
  lives at `/dashboard`. Point people there or change `/` to redirect when
  the JSON root stops being useful.
- No settings write-path yet — `.fletcher.json` is repo-managed; the
  dashboard is read-only by design for v1.
- **Known gaps for the frontend (Phase 14 backlog):** review verdict
  and summary are not persisted anywhere (needs a new migration +
  `test/setup.ts` extension) so the most interesting column can't be shown;
  no deep-links to the GitHub PR or posted comments; no pagination past 25
  runs; effective `.fletcher.json` not displayed. Accessibility verification
  remains pending. Overflow and empty-state defects were fixed 2026-09-28.
- Live verification used `shahparshva72/cv#14` with an isolated arithmetic
  fixture. It confirmed a `not_my_tempo` verdict and a correctly anchored
  critical finding on line 4.

## E2E re-test and fixes — 2026-09-28

Local Worker on an isolated D1, signed webhook deliveries replayed for
fixture PRs 15–20 in `shahparshva72/cv`, real GitHub and Gemini calls.
All four 2026-09-14 defects are now resolved:

- **Comment IDs (fixed).** Root cause: `GET /pulls/{n}/reviews/{id}/comments`
  returns `line: null` (only `GET /pulls/{n}/comments` includes it), so the
  write-back match never succeeded. Matching now ignores a null line; the
  test stub mirrors GitHub's real shape. Live: run 12 stored comment
  `4116771873`.
- **OAuth redirect (fixed earlier)** — callback lands on `/dashboard`.
- **Empty states (fixed).** Failed, skipped (completed without a model),
  in-progress, and cancelled runs get distinct messages; only reviewed runs
  get "...Good job."
- **Mobile overflow (fixed).** Tables scroll within `.table-wrap`; long
  text wraps. All dashboard pages measure 390px at a 390px viewport.

Passed live: routes/auth guards, webhook signature and schema checks,
idempotent redelivery, full review on PR 16, disabled/ignore/threshold/
oversized/malformed config fixtures, `/fletcher again` and its guards,
read-API isolation, dashboard sign-out revocation. Not exercised live:
browser OAuth, tunnel redelivery, intensity tone, rate-cap saturation.
Gemini `gemini-3.8-flash` intermittently returned 503 (correctly recorded
as `gemini_error`); retries succeeded.

## Manual test findings — 2026-09-14

Latest results: [detailed test report](./MANUAL_TEST_RESULTS_2026-09-14.md).
Partial verification with four confirmed defects; not release sign-off.
All four were resolved on 2026-09-28 (see the section above).
No application code changed. The initial notes below predate live testing;
the detailed report supersedes their pending statuses.

- Step 3: real reviews completed, but all three new posted inline comments
  have NULL `github_comment_id` in D1.
- Steps 4–6: local replay, real reopen, findings memory, and manual-command
  guards worked. Fresh manual run queued but model review hit quota.
- Step 7: disabled passed. Ignore/threshold/malformed config resolved, but
  Gemini 503/429 blocked complete reviews. Intensity output not verified.
- Step 8: oversized diff and isolated bad-key tests produced expected
  errors. Original secrets unchanged; good-key recovery hit quota.
- Step 10: real OAuth worked but redirected to service JSON at `/` instead
  of `/dashboard`. Browser cookie/tamper/logout checks remain partial.
- Step 11: read API, installation isolation, ID validation, and D1 usage
  sums passed with locally generated fixture sessions.
- Step 12: mobile tables overflow; long titles cause extreme overflow.
  Failed/disabled runs incorrectly show “No findings. ...Good job.”
  HTML escaping passed.
- Prompt tuning: carousel bugs both critical; calibrate severity. Summary
  phrase “sheer carelessness” risks personal tone.
- Setup pending: replacement tunnel URLs and Issue comment subscription.
  Report lists open test PRs, exact evidence, and unverified items.

### Initial setup notes

- Step 0: all six gates passed (lint, format, application/test typechecks,
  dry-run build, and 103 tests across 14 files). Used pnpm 11.1.3 from
  `/Users/parshvashah/Library/pnpm/pnpm`; PATH pnpm 12.4.1 hung.
  Installed Node is 26.8.2; requested 26.7.0 is not installed.
- Step 0: local migrations already applied; `review_runs` has all three
  token columns. Existing run 2 (PR 14) is completed with 1456 total tokens;
  this historical row is not evidence of a new end-to-end test.
- Steps 1–2: live local HTTP checks passed: root/health 200, unknown route
  404 `not_found`, unsigned webhook 401 `invalid_signature`, signed ping
  202 `ignored`.
- Step 10: signed-out landing rendered correctly in Chrome at desktop
  width, with styled GitHub sign-in link and no raw HTML artifacts.
  Callback replay returned 401 `invalid_oauth_state`.
- Step 10 discrepancy (source inspection): expected successful sign-in
  redirect `/dashboard`; actual callback code redirects `/`, which returns
  service JSON. Real OAuth completion still pending.
- Step 11: unauthenticated repositories and usage endpoints returned 401.
  Invalid IDs also return 401 before authentication; authenticated 400
  validation remains pending.
- Setup blocker: GitHub App webhook points to an older tunnel and its
  OAuth callback field is empty. Requested updated tunnel webhook/callback
  URLs from user, plus confirmation of the throwaway test repository.
- Steps 3–8, authenticated portions of 10–11, and dashboard detail/mobile
  checks in 12 are not yet verified. Step 9's permitted automated rate-cap
  path passed with the suite; no live cap saturation attempted.
- Playbook caveat: step 6's push can enqueue a synchronize run before the
  manual comment arrives, so a fresh `manual` run is not deterministic.
  Arrange delivery ordering when exercising that case.

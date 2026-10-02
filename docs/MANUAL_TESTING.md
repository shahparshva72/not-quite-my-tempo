# Manual Testing Playbook

A verification pass over everything built through Phase 11. Work top to
bottom; each step lists the action and the expected result. Check items off
in a copy, not in this file.

Two ways to run it:

- **Local**: `pnpm dev` + the Wrangler tunnel (press `t` in the dev
  terminal). Use the tunnel URL as `BASE_URL`.
- **Deployed**: the Worker URL as `BASE_URL`.

The GitHub webhook flows require a real GitHub App installed on a throwaway
test repository. Never use `wrangler dev --remote` (Workflow bindings break).

---

## 0. One-time setup

- [ ] GitHub App exists with: webhook URL `BASE_URL/webhooks/github`,
      content type `application/json`, webhook secret set; **Pull requests
      read/write** and **Issues read** permissions; subscribed to **Pull
      request** and **Issue comment** events; OAuth callback URL
      `BASE_URL/auth/callback`; a generated OAuth client secret.
- [ ] Local: `apps/api/.dev.vars` contains `GITHUB_WEBHOOK_SECRET`,
      `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 — convert with
      `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`),
      `GEMINI_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`,
      `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`.
- [ ] Deployed: the same seven values exist as Worker secrets
      (`wrangler secret put ...`).
- [ ] Migrations applied: `pnpm db:migrate:local` (or `:remote`). Verify:

  ```sh
  pnpm --filter @not-quite-my-tempo/api exec wrangler d1 execute DB --local \
    --command "PRAGMA table_info(review_runs)"
  ```

  Expect `input_tokens`, `output_tokens`, `total_tokens` columns (migration
  `0001_*`), plus `users` and `sessions` tables (migration `0002_*`).

- [ ] Automated gate is green before manual testing:
      `pnpm lint && pnpm format:check && pnpm typecheck && pnpm typecheck:test && pnpm build && pnpm test`.

Useful inspection commands (run in separate terminals while testing):

```sh
# Live logs (deployed)
pnpm --filter @not-quite-my-tempo/api exec wrangler tail

# Workflow instances (add --local for local dev)
pnpm --filter @not-quite-my-tempo/api exec wrangler workflows instances list review-pull-request --local

# Review runs
pnpm --filter @not-quite-my-tempo/api exec wrangler d1 execute DB --local --command \
  "SELECT id, pull_request_number, head_sha, status, trigger, error_code, model, total_tokens FROM review_runs ORDER BY id DESC LIMIT 10"

# Findings
pnpm --filter @not-quite-my-tempo/api exec wrangler d1 execute DB --local --command \
  "SELECT id, review_run_id, file_path, line, severity, github_comment_id FROM findings ORDER BY id DESC LIMIT 20"
```

## 1. Service basics

- [ ] `curl BASE_URL/` → 200, JSON with `"name": "not-quite-my-tempo-api"`.
- [ ] `curl BASE_URL/health` → 200, `{"status":"ok"}`.
- [ ] `curl BASE_URL/nope` → 404, `{"error":{"code":"not_found",...}}`.

## 2. Webhook signature verification

- [ ] Unsigned request is rejected:

  ```sh
  curl -i -X POST BASE_URL/webhooks/github \
    -H 'x-github-event: pull_request' -d '{}'
  ```

  Expect 401 `invalid_signature`.

- [ ] Correctly signed request is accepted (any body; unsupported events are
      ignored):

  ```sh
  BODY='{}'
  SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"
  curl -i -X POST BASE_URL/webhooks/github \
    -H 'x-github-event: ping' -H "x-hub-signature-256: $SIG" -d "$BODY"
  ```

  Expect 202 `{"status":"ignored"}`.

## 3. Full review on PR opened (the core loop)

- [ ] In the test repo, open a PR with a small diff containing at least one
      deliberate flaw (e.g. an obvious off-by-one or an unchecked null).
- [ ] GitHub → App → Recent deliveries: the `pull_request.opened` delivery
      got **202** with `{"status":"queued","reviewRunId":N}`.
- [ ] Workflow instance for `review-run-N` reaches `complete`.
- [ ] D1: run row is `completed`, `model` = `gemini-3.8-flash` (or your
      override), token columns are non-null.
- [ ] The PR shows a review: summary comment starting with a 🥁 verdict
      heading, severity counts, and inline comments anchored to changed
      lines. Inline comment bodies end with a `severity: … · confidence …`
      footer.
- [ ] Findings rows exist; anchored ones have `github_comment_id` set.
- [ ] Persona check: theatrical but **never personal**, and every finding
      contains a concrete fix. If not, file a prompt-tuning note.

## 4. Idempotency

- [ ] GitHub → the delivery from step 3 → **Redeliver**. Expect 202 with
      `"already_processed"`, the same `reviewRunId`, **no** new run row, and
      **no** duplicate review on the PR.

## 5. Findings memory on synchronize

- [ ] Push a new commit to the same PR that **fixes one** prior finding and
      **leaves one** unfixed.
- [ ] A new run completes for the new head SHA.
- [ ] New review on the PR: the summary grudgingly acknowledges the fix; the
      surviving finding is re-raised **escalated one severity level** with a
      "second time" note; the fixed one is not re-listed.
- [ ] Close and reopen the PR → `reopened` delivery behaves like step 3/4
      (same SHA ⇒ `already_processed`).

## 6. /fletcher again

- [ ] As a repo collaborator/owner, comment `/fletcher again` on the PR.
      Expect 202 `already_processed` (head SHA unchanged) — no new review.
- [ ] Push a trivial commit, then comment `/fletcher again`. Expect a new
      run with `trigger = 'manual'` in D1 and a fresh review on the PR.
- [ ] From an account with **no** repo standing, comment `/fletcher again`.
      Expect 202 `{"status":"ignored"}` and no run.
- [ ] An ordinary comment ("lgtm") → `ignored`, no run.

## 7. .fletcher.json

For each case, commit the file at the root of the **default branch**, then
open a PR (config on the PR branch alone must have no effect):

- [ ] `{"enabled": false}` → run completes with **no** Gemini call and no PR
      comment; logs show `review_skipped_disabled`; run row `completed`,
      zero findings.
- [ ] `{"ignore": ["docs/**"]}` + a PR touching `docs/x.md` and one source
      file → review comments only on the source file.
- [ ] `{"severityThreshold": "critical"}` on a PR with minor nits → summary
      posts but suggestion/warning findings are neither persisted nor
      commented.
- [ ] `{"intensity": "sectional"}` → noticeably dry, catchphrase-free tone.
      `{"intensity": "carnegie"}` → harsher standard, still no personal
      attacks.
- [ ] `{"tone": "ruthless"}` on the same PR as a `standard` run → full
      Fletcher voice (interrogation, orders, "Not. Quite. My. Tempo."
      heading, no "good job"), but the same findings, severities, and
      verdict; nothing aimed at the author, no profanity or threats.
- [ ] Malformed file (`{ not json`) → review proceeds with defaults; logs
      show `invalid_review_config`; nothing fails.

## 8. Failure taxonomy

- [ ] Oversized diff: open a PR with > 300 KB of text changes in reviewable
      files → run ends `failed` with `error_code = 'diff_too_large'`; no
      Gemini call (verify via logs/tokens NULL).
- [ ] Bad Gemini key (locally set `GEMINI_API_KEY=broken`) → run `failed`,
      `error_code = 'gemini_error'` after the client's internal retries.
- [ ] Bad App private key → run `failed`, `error_code = 'github_auth_error'`.
- [ ] Restore correct values afterward and confirm a new PR reviews cleanly.

## 9. Rate cap

The cap is 50 runs/installation/24 h — impractical to hit by hand. Verify
one of:

- [ ] Unit path: `apps/api/test/review-requests.test.ts` covers it (part of
      `pnpm test`), **or**
- [ ] Temporarily set `DAILY_REVIEW_RUN_CAP = 1` locally, deliver two PR
      events → second returns `{"status":"rate_limited"}` and logs
      `review_rate_limited`. **Revert before committing.**

## 10. Auth (browser)

- [ ] Visit `BASE_URL/dashboard` signed out → landing page with "Sign in
      with GitHub" (styled, no raw HTML artifacts).
- [ ] Click sign in → GitHub authorize → redirected back to `/dashboard`.
      DevTools: `nqmt_session` cookie is `HttpOnly`, `Secure`,
      `SameSite=Lax`, expires in one hour, and contains only an opaque token;
      the `nqmt_oauth_state` cookie is gone.
- [ ] Tamper: edit the cookie value in DevTools, reload → treated as signed
      out (landing page), not an error.
- [ ] Replay `BASE_URL/auth/callback?code=x&state=y` directly → 401
      `invalid_oauth_state`.
- [ ] Use the dashboard's sign-out button (`POST /auth/logout`) → signed
      out. Replaying the old session cookie against `/api/me` returns 401.
      `GET /auth/logout` returns 405 and does not sign the user out.

## 11. Read API (curl with the session cookie)

Copy the `nqmt_session` value from the browser:

```sh
COOKIE='nqmt_session=<value>'
curl -H "cookie: $COOKIE" BASE_URL/api/me
curl -H "cookie: $COOKIE" BASE_URL/api/repositories
curl -H "cookie: $COOKIE" BASE_URL/api/repositories/1/runs
curl -H "cookie: $COOKIE" BASE_URL/api/runs/1/findings
curl -H "cookie: $COOKIE" BASE_URL/api/usage
```

- [ ] All five return 200 with expected data; `/api/usage` token sums match
      the D1 query from section 0.
- [ ] Without the cookie → 401. With a repo/run ID you cannot access,
      including a private sibling repository in the same installation → 404
      (not 403 — no ID enumeration).
- [ ] `/api/me` returns the persistent GitHub identity and session expiry,
      without tokens or token hashes. A renamed GitHub login retains the
      same local user ID after the next sign-in.
- [ ] `/api/repositories/abc/runs` → 400 `invalid_id`.

## 12. Dashboard (browser — this is the unverified surface, look closely)

- [ ] `/dashboard`: repositories table with run counts and token totals;
      numbers right-aligned; login shown with a sign-out button.
- [ ] Repository page: runs with PR number, trigger, status (color-coded),
      error code, model, tokens, timestamp. Long values don't wreck the
      layout.
- [ ] Run page: findings with severity colors, `path:line`, title + message,
      confidence, comment ID. A clean run shows "No findings. ...Good job."
- [ ] A failed run (from section 8) displays its error code.
- [ ] Long file paths / titles: check table overflow. Narrow window /
      phone-width: check readability. **Note anything ugly — this page has
      never been seen by human eyes before this step.**
- [ ] URL for another installation's repo/run → "Not my chart." 404 page.

## 13. Record results

- [ ] Note failures/oddities in `docs/PROGRESS.md` under a "Manual test
      findings" heading with date, step number, and expected vs actual.
- [ ] Prompt-quality observations (false positives, tone slips, bad
      anchors) go in the same place — they feed the Phase 12 prompt-tuning
      backlog.

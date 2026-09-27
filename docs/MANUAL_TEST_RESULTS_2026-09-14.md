# Manual test results — 2026-09-14

Playbook: [MANUAL_TESTING.md](./MANUAL_TESTING.md).

**Partial verification: four confirmed defects; not release sign-off.**
No application source or real secrets were changed. Tests used local D1,
the local Worker, real GitHub/Gemini calls, and the user-authorized private
test repository `shahparshva72/cv`. Luna subagents ran the gates and initial
fixtures before hitting account usage limits; the parent continued.

## Confirmed defects

1. **Step 3 — comment IDs not persisted.** Run 5 posted GitHub comments
   `4003347985` and `4003347990`; run 9 posted `4003361627`. All three
   corresponding `findings.github_comment_id` fields remain NULL, although
   the runs completed. Expected: IDs retained for anchored findings.
   Inspect polling and matching in `application/review-workflow.ts`;
   the precise cause has not been established.
2. **Step 10 — OAuth redirect.** Successful real OAuth returned 302 to `/`
   (service JSON), not `/dashboard`. Manually opening `/dashboard` showed
   authenticated repositories. Dia also blocked the root with
   `ERR_BLOCKED_BY_CLIENT`; that browser behavior is separate from the
   incorrect destination.
3. **Step 12 — horizontal overflow.** In Chrome at 390px, overview content
   measured 495px, run history 766px, and findings 802px. An isolated long,
   unbroken finding title expanded content to 3674px on mobile and 3730px
   at a 1200px desktop viewport. Paths wrapped; the title did not.
4. **Step 12 — misleading success message.** Failed run 7 displays
   `failed · diff_too_large` followed by `No findings. ...Good job.`
   Disabled run 4 also receives praise without a model review. Expected:
   distinguish clean reviews from skipped, failed, and unfinished runs.

## Execution checklist

| Step              | Result                     | Evidence / limits                                                                                                                                                                                                                                             |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: setup          | Partial                    | Seven local bindings loaded. App has contents read, issues read, metadata read, pull requests write. Pull request event enabled; Issue comment missing at last check. Production not tested.                                                                  |
| 0: migrations     | Pass                       | Both migrations applied; all three token columns present.                                                                                                                                                                                                     |
| 0: gates          | Pass                       | Lint, format, app/test typechecks, dry-run build, 103 tests across 14 files. Managed pnpm 11.1.3; installed Node 26.8.2 rather than unavailable 26.7.0.                                                                                                       |
| 1                 | Pass                       | Root/health 200 with expected JSON; unknown path 404 not_found.                                                                                                                                                                                               |
| 2                 | Pass                       | Unsigned webhook 401 invalid_signature; signed ping 202 ignored.                                                                                                                                                                                              |
| 3                 | Partial / defect           | PR 16 opened delivery: 202 queued, run 5. Workflow CLI: Completed. Two anchored findings, verdict/severity summary and confidence footers correct. Model gemini-3.8-flash; 2159 total tokens. Comment IDs failed persistence.                                 |
| 4                 | Partial                    | Exact initial GitHub payload replayed to signed local endpoint: 202 already_processed, run 5; no duplicate review. Actual GitHub redelivery after the pause hit expired tunnel (502), so transport retest pending.                                            |
| 5: memory         | Partial                    | Run 9 completed, 1980 total tokens. Fixed forward-navigation bug omitted and acknowledged; backward bug retained with second-time note. Initial findings were already critical, so escalation from a lower severity was not exercised.                        |
| 5: reopen         | Pass                       | Actual PR 16 reopened delivery: 202 already_processed, run 9. Closed event ignored.                                                                                                                                                                           |
| 6: manual         | Partial                    | Signed OWNER command on unchanged head: already_processed, run 9. Fresh trivial commit queued run 18 with manual trigger; Gemini quota prevented fresh review. Immediate command initially observed old GitHub head; retry after propagation queued new head. |
| 6: guards         | Local HTTP pass            | Signed NONE association command and ordinary lgtm returned 202 ignored. No live outsider account used. Real issue-comment delivery blocked by missing subscription.                                                                                           |
| 7: disabled       | Pass                       | PR 15/run 4 completed, review_skipped_disabled log, no review, zero findings, NULL model/tokens.                                                                                                                                                              |
| 7: ignore         | Partial                    | PR 17/run 12 fetch-step output resolved docs/** ignore and excluded docs fixture. Gemini failure prevented source-only comment verification.                                                                                                                  |
| 7: threshold      | Partial                    | PR 19/run 13 resolved critical threshold; provider failure prevented generated-finding filtering verification.                                                                                                                                                |
| 7: malformed      | Partial                    | PR 20/run 14 resolved malformed JSON to defaults; provider failure prevented completed review.                                                                                                                                                                |
| 7: intensity      | Not run live               | Automated prompt variants passed, but no live sectional/carnegie comparison completed.                                                                                                                                                                        |
| 8: oversized      | Pass                       | PR 18/run 7: diff_too_large, fetched diff 701178 bytes versus 300000 cap, NULL model and all tokens.                                                                                                                                                          |
| 8: bad App key    | Pass, isolated             | Worker 8791 with isolated D1: run 1 failed github_auth_error, invalid PKCS8 import. Original secrets unchanged.                                                                                                                                               |
| 8: bad Gemini key | Pass, isolated             | Worker 8792 with isolated D1: run 1 failed gemini_error, provider 400 API_KEY_INVALID. Original secrets unchanged.                                                                                                                                            |
| 8: recovery       | Blocked                    | Good-key subsequent reviews failed provider quota; no post-failure clean review claimed.                                                                                                                                                                      |
| 9                 | Pass via unit path         | Playbook-permitted cap tests passed; no live saturation/concurrency check.                                                                                                                                                                                    |
| 10: landing/login | Partial / defect           | Styled landing rendered correctly. Real OAuth authenticated successfully; redirect defect above.                                                                                                                                                              |
| 10: cookies       | Partial                    | State-cookie HTTP headers: HttpOnly, Secure, SameSite=Lax, 600s TTL. Session attributes/state deletion match source, not independently inspected in browser DevTools.                                                                                         |
| 10: tamper/replay | Local HTTP pass            | Tampered generated session returned signed-out landing, 200. Callback replay: 401 invalid_oauth_state. No browser cookie editing performed.                                                                                                                   |
| 10: logout        | HTTP pass                  | 302 to / and session Max-Age=0. Real browser sign-out round trip not verified.                                                                                                                                                                                |
| 11                | Pass with fixture sessions | Four APIs returned 200 using actual repo 990002/run 2; authenticated bad ID 400; absent cookie 401. Empty-installation session received 404 for existing run. Sessions generated locally, not copied from OAuth browser.                                      |
| 11: usage         | Pass                       | API matched D1: input 3017, output 721, total 5595. Provider total may exceed input plus output; each matched its stored column.                                                                                                                              |
| 12: desktop       | Partial / defects          | Totals right-aligned; history/findings render expected fields and status colors. Missing/unauthorized pages show Not my chart. Comment IDs missing in new runs. Failed/disabled empty text misleading.                                                        |
| 12: responsive    | Fail                       | Overflow measurements above. Chrome inspected real Worker HTML through a loopback-only authenticated preview. Long-text fixture used isolated D1. Literal script markup escaped; zero script elements created.                                                |
| 13                | Pass                       | This report and PROGRESS.md record evidence, defects, and remaining work.                                                                                                                                                                                     |

## Reproduction references

- [PR 16: core/memory/manual](https://github.com/shahparshva72/cv/pull/16).
  Initial SHA `314f4857327af8af3553ecc54207c55d3e18aede`, run 5;
  fix SHA `56f8a87ec8b129ea67c0d7cc5fcb0489417b2b16`, run 9;
  trivial SHA `b5baa9ebbe71b0d70fe9c86bc55507a17397fb19`, run 18.
- [PR 15: disabled](https://github.com/shahparshva72/cv/pull/15).
- [PR 17: ignore](https://github.com/shahparshva72/cv/pull/17).
- [PR 18: oversized](https://github.com/shahparshva72/cv/pull/18).
- [PR 19: threshold](https://github.com/shahparshva72/cv/pull/19).
- [PR 20: keys/malformed](https://github.com/shahparshva72/cv/pull/20).

PRs remain open as reproducible fixtures. Nothing was merged to cv/main.
Temporary agent files were moved out of the application repository.
Isolated invalid-key Workers and authenticated preview servers were stopped;
the main Worker and replacement tunnel remain running for pending checks.

## Prompt observations

The navigation defects were real, comments supplied concrete fixes, and
memory correctly acknowledged the fixed issue. Both were graded critical;
calibrate whether carousel navigation merits the highest severity.
The initial summary's “sheer carelessness” risks attributing a personal
failing rather than discussing code. Record for Phase 12 prompt tuning.
This small sample does not establish broader false-positive or tone quality.

## Remaining blockers

Initial model failures were 503 high demand. Later attempts and serial
retries failed 429 with a free-tier limit of five requests/minute for
gemini-3.8-flash. Further output/tone testing needs provider availability.
Failed same-SHA runs deduplicate; resume with explicit workflow restart or
a fresh test commit.

The first tunnel expired during the long pause. Replacement:
`https://adopted-medicare-myth-environments.trycloudflare.com`.
User was asked to save webhook `/webhooks/github`, callback
`/auth/callback`, and enable Issue comment. Still pending at report time.

## Credential handling incident

An early redaction command exposed the multiline App private key in tool
output. The GitHub App settings page also exposed its OAuth client secret
in browser output. Neither value is included in this report. The user was
notified that both credentials should be rotated; rotation was not performed.

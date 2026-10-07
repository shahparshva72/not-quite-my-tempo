# Design: workspace Gemini keys and the 5-review trial (Phase 16, part 1)

> Extended by [MULTI_PROVIDER_BYOK_DESIGN.md](./MULTI_PROVIDER_BYOK_DESIGN.md):
> keys can now be OpenAI, Anthropic, or Gemini, with a chosen model, and the
> paid plan spends review credits.

Status: **approved 2026-09-29** ("start with #1 and continue"). Billing
(the paid plan) is part 2 and slots into the key choice below without
schema changes to this part.

## Goal

The free tier is bring-your-own-key: each workspace stores its own Gemini
API key and reviews run on it. Every workspace gets **5 reviews on the
platform key** first, so people can try Fletcher before creating a key.
The trial belongs to the workspace, not the installation, so reinstalling
Fletcher doesn't reset it.

## Data

Migration `0008`, additive only:

```
workspaces
  + gemini_key_ciphertext  text      -- AES-256-GCM, TOKEN_ENCRYPTION_KEY,
                                      -- context "workspace:<id>:gemini"
  + gemini_key_last4       text      -- shown in the UI; the key never is
  + gemini_key_updated_at  timestamp
  + gemini_key_updated_by  integer references users(id) on delete set null
  (trial usage is derived from review_runs; see "Counting free reviews")

review_runs
  + key_source             text      -- 'workspace' | 'platform'; null for
                                      -- runs that never reached Gemini
```

The existing `TOKEN_ENCRYPTION_KEY` secret encrypts workspace keys too, so
there's no new secret. The encryption context binds each ciphertext to its
workspace, so a copied value won't decrypt elsewhere.

## Which key a review uses

A new workflow step, **"choose gemini key"**, runs right before the Gemini
call. It runs after `.fletcher.json` skips and diff fetch failures, so those
never use up trial reviews.

1. The workspace has a key: use it (`key_source = 'workspace'`).
2. _(Part 2: the workspace is on a paid plan: use the platform key.)_
3. Trial reviews remain: take one atomically and use the platform key
   (`key_source = 'platform'`). The same statement also checks the
   platform-wide daily cap (`TRIAL_DAILY_REVIEW_CAP`, default 100 trial
   reviews per rolling 24 hours across all workspaces). When only the cap
   refuses the claim, the run fails with `error_code = 'trial_paused'` and
   Fletcher comments once per pull request; no free review is used.
4. Otherwise: the run fails with `error_code = 'no_gemini_key'`. Fletcher
   posts one comment on the pull request explaining how to add a key.
   There is one comment per pull request, not one per push.

### Counting free reviews (revised 2026-09-30)

There is no counter. A free review **counts while its run is queued,
running, or completed on the platform key**; failed and cancelled runs never
count. The first version kept a `trial_reviews_used` counter that the key
step incremented and a refund step decremented. Reviewing every path showed
four ways that miscounts:

| Case                                                                | Counter behaviour                    | Derived count                                                                |
| ------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| DB write fails after the trial is taken; Workflows retries the step | Takes a second review                | The run records its own claim; a retry sees it and claims nothing            |
| Refund write succeeds but its reply is lost; the step retries       | Refunds twice                        | Nothing to refund: a failed run just stops counting                          |
| `/fletcher again` after a non-Gemini failure (post, DB, stuck)      | Charges the pull request twice       | The failed attempt stopped counting; the retry claims once, within the limit |
| Gemini answered but saving or posting the review failed             | User loses a review and gets nothing | Failed runs don't count                                                      |

Claiming is one statement, so concurrent runs can't pass 5:

```sql
UPDATE review_runs
SET key_source = 'platform', trial_workspace_id = :workspace
WHERE id = :run AND key_source IS NULL
  AND (SELECT count(*) FROM review_runs
       WHERE trial_workspace_id = :workspace AND key_source = 'platform'
         AND status IN ('queued', 'running', 'completed')) < 5
```

Deleting a workspace's data deletes its runs, so their counted trial reviews
first move to `workspaces.trial_reviews_carried` (migration `0015`), which
the claim and the settings page add to the count. Deleting and reinstalling
doesn't restart the trial ([ACCOUNT_DELETION.md](./ACCOUNT_DELETION.md)).

`trial_workspace_id` (migration `0012`) fixes which workspace was charged
when the claim happens, so transferring a repository to another account
doesn't move its trial history. Migration `0011` drops the old counter.
Retries clear the claim (`requeueFailed`) and must claim again under the
same limit. We absorb the Gemini cost of failed reviews; that is the price
of never charging someone for a review they didn't get.

When Gemini rejects a **workspace** key (HTTP 400, 401, or 403), the run
fails with `gemini_key_rejected`: "your workspace's Gemini key was
rejected; an admin can replace it in settings."

## Gemini API and Vertex AI keys (added 2026-09-30)

Keys work with one of two Google APIs, and both take the key in the
`x-goog-api-key` header and the same `generateContent` body:

- **Gemini Developer API** (`generativelanguage.googleapis.com`): Google AI
  Studio keys, classic `AIza…` or the newer format.
- **Vertex AI express mode** (`aiplatform.googleapis.com/v1/publishers/google/models/...`):
  Vertex AI API keys, which are bound to a service account with
  `roles/aiplatform.expressUser` and often restricted to `aiplatform`.

On save, Fletcher asks the Gemini API's free model list first, then Vertex's
free `countTokens`, and stores which one accepted the key
(`workspaces.gemini_key_provider`, migration `0010`). The platform key's API
comes from `GEMINI_API_PROVIDER`. Verified live with a real Vertex express
key: header auth, the default model, and Fletcher's full structured-output
request all work.

## Managing the key

- **Page**: `/workspaces/:id/settings` ("Gemini key").
  - Everyone in the workspace sees the status: the key ending in `…AbCd`,
    who added it and when, or how many trial reviews are left.
  - Admins and owners can save or replace the key (password field with
    autocomplete off) and remove it.
- **On save**, the key is checked with one free call
  (`GET /v1beta/models?pageSize=1`). A rejected key is not stored, and the
  form says so. If Gemini itself is unavailable, the key is not stored and
  the form asks the user to try again.
- **Audit**: saving and removing write `audit_events`
  (`gemini_key.saved`, `gemini_key.removed`). The only value recorded is
  `last4`.
- **Authorization**: `view_settings` needs member, and `manage_settings`
  needs admin, both in `application/authorization.ts`. The existing
  same-origin POST middleware covers the forms.

## Where it shows

- **Dashboard**: each workspace heading shows "Reviews use your Gemini
  key" or "3 of 5 free reviews left", linking to settings.
- **Repository and review pages**: failures say "no Gemini key: add one in
  settings" or "your Gemini key was rejected".
- **Pull request comment**: posted when a review is blocked, with a link to
  the settings page. The link is built from the Worker's public origin,
  which the webhook request carries into the workflow parameters.

## Failure modes

| Failure                                    | Behavior                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Two reviews race for the last trial review | The conditional update lets exactly one win. The other is blocked (tested)                                                |
| `TOKEN_ENCRYPTION_KEY` missing or rotated  | Saving fails with an error. Reviews on a workspace key fail as `gemini_key_unreadable` until an admin saves the key again |
| Gemini down while validating on save       | Key not stored. "Gemini didn't answer; try again"                                                                         |
| Key removed while a review is queued       | That review re-checks at its key step and falls through to trial or blocked                                               |
| Blocked PR gets many pushes                | One comment per pull request (checked against earlier `no_gemini_key` runs)                                               |
| Posting the blocked comment fails          | Logged. The run is still marked `no_gemini_key`                                                                           |

## Build sequence

1. Migration and repositories: key storage, atomic trial take, run key
   source.
2. Gemini key validation (`packages/gemini`), plus the settings logic and
   authorization.
3. Workflow key step: per-run key, blocked comment, and the new error codes.
4. UI: settings page, dashboard status, failure wording.
5. Tests (the concurrency race, no key material in step output or HTML),
   then docs.

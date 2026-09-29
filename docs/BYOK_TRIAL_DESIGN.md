# Design: workspace Gemini keys and the 5-review trial (Phase 16, part 1)

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
  + trial_reviews_used     integer not null default 0

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
   (`key_source = 'platform'`).
4. Otherwise: the run fails with `error_code = 'no_gemini_key'`. Fletcher
   posts one comment on the pull request explaining how to add a key.
   There is one comment per pull request, not one per push.

Taking a trial review is a single conditional update, so concurrent
reviews can't overspend:

```sql
UPDATE workspaces SET trial_reviews_used = trial_reviews_used + 1
WHERE id = ? AND trial_reviews_used < 5
RETURNING trial_reviews_used
```

The step's output is only the key **source**, never the key. Workflows
persist step outputs, so the key is decrypted inside the Gemini step itself
and never stored. Because step outputs are cached, a retried Gemini step
does not take a second trial review. A trial review is refunded when the run used the platform key and failed
with `gemini_error` (outage, quota, or an unusable answer), in its own
workflow step so a retry can't refund twice. Live testing found Gemini
returning 503 "high demand", which would otherwise cost users a trial
review. Failures before the key step never take one.

When Gemini rejects a **workspace** key (HTTP 400, 401, or 403), the run
fails with `gemini_key_rejected`: "your workspace's Gemini key was
rejected; an admin can replace it in settings."

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

# Account and workspace deletion

Phase 15 asks that a user can leave the service and that the privacy
policy's deletion promise doesn't depend on someone emailing us. There are two
self-service deletions, because Fletcher stores two kinds of things: the
person (a GitHub user who signed in) and the workspace (a GitHub account,
user or organization, that installed the App).

## Delete your account (`/account`)

Any signed-in user. They type their GitHub username to confirm, then
`POST /account/delete`:

1. Deletes the `users` row. The foreign keys do the rest: sessions and
   memberships cascade; `audit_events.actor_user_id` and
   `workspaces.gemini_key_updated_by` are set to null.
2. Revokes the user's authorization of the App on GitHub
   (`DELETE /applications/{client_id}/grant`) with the token stored,
   encrypted, on their session. This is a best effort: the account is
   already gone, and a failure is only logged (`github_grant_revoke_failed`).
   The confirmation page tells them where to revoke it on GitHub themselves.
3. Clears the session cookie and redirects to `/account/deleted`.

Workspaces stay. They belong to their GitHub accounts, and other members may
still use them. The account page lists the workspaces the user owns and says
that reviews there keep running until an owner deletes the workspace's data or
uninstalls Fletcher. Signing in again later creates a new account.

## Delete a workspace's data (workspace settings)

Owners only (`delete_workspace`). They type the GitHub account name to
confirm, then `POST /workspaces/:id/delete`:

1. **Billing check.** Refuses (409) while a subscription would charge again:
   open (`active`, `trialing`, `past_due`, `unpaid`) and not set to cancel at
   period end. With billing on, Polar is asked rather than the stored plan,
   as checkout does, and its answer is stored. Fletcher can't cancel a
   subscription itself (the Polar token has no `subscriptions:write`), so the
   owner cancels in Manage billing first. A plan already cancelled at period
   end doesn't block, but the owner loses the rest of the period.
2. **Uninstall.** `DELETE /app/installations/{id}` with the App JWT for each
   of the workspace's installations that isn't already `removed`. A 404 means
   it's already gone and counts as success. Uninstalling comes before
   deleting because, while the App is installed, GitHub keeps sending
   webhooks that would store new repositories and runs. If GitHub fails, the
   owner gets a 503 and nothing is deleted, so retrying is safe.
3. **Delete, in one D1 batch** (`WorkspaceRepository.deleteDataWithAudit`):
   the workspace's audit history, findings, retries, review runs,
   repositories, installations, and memberships. It also clears the API key,
   carries the plan credits (below), and sets `data_deleted_at`. One `workspace.data_deleted` audit row records
   who did it and how many repositories and reviews went.
4. Redirects to `/account?notice=workspace_deleted`.

### What's kept, and why

The `workspaces` row stays, holding the GitHub account ID and name, the Polar
customer and subscription references, and `trial_reviews_carried`:

- **Trial.** Free reviews are derived from runs (BYOK_TRIAL_DESIGN.md). If the
  runs simply disappeared, deleting and reinstalling would hand out 5 new free
  reviews. So before the runs are deleted, the counted trial reviews among
  them are added to `trial_reviews_carried` on whichever workspace they were
  charged to (usually this one; a repository transferred in may hold reviews
  charged to another workspace). Trial claims and the settings page add the
  carried count to the runs they count.
- **Plan credits.** Paid-plan credits are also derived from runs, so a
  workspace whose plan is cancelled but still running could delete and get
  the period's credits back. Before the runs go, the credits its own runs
  used in their latest billing period are stored in `credits_carried_x100`
  and `credits_carried_period_start`; the credit count adds them for that
  period only.
- **Billing.** Polar keeps invoices as the law requires; the references let
  Manage billing work if the account comes back.
- **Reinstalling** attaches the new installation to the same row (upsert on
  `github_account_id`), so the trial and billing carry over.

Reviews already posted as pull request comments stay on GitHub; Fletcher has
no way to remove them once the App is uninstalled.

### Races

- **`installation.deleted` arrives after the delete** (GitHub sends it because
  of step 2). Removing an installation that isn't stored is now a no-op, so
  the webhook doesn't bring back an installation row.
- **A pull request webhook already in flight** when the App was uninstalled
  can still store the installation, repository, and a run again. The review
  fails at `github_auth_error` (the installation token can't be minted), and
  no member can see the rows. If `installation.deleted` arrives after it, the
  installation is marked removed; if it arrived first, the rows stay until
  the owner deletes again. Nothing new arrives after that, because the App is
  uninstalled.
- **A review running during the delete** loses its run row. Its later steps
  fail to find the run, and posting fails because the App is uninstalled.

## Not covered yet

- Data export ("access" requests): still by email, as the privacy policy says.
- Automatic retention limits (for example, purging review history older than
  a year): nothing expires on its own yet.
- Cloudflare's own request logs follow Cloudflare's retention.

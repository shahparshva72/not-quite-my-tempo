# Design: Workspaces, memberships, and roles (Phase 12)

Status: **approved 2026-09-29**, with Option A (stored, encrypted GitHub
user token) for access refresh.

## Why now

The trial (5 platform-key reviews), the workspace's own Gemini key, and the
paid plan all need an owner that outlives a GitHub installation. Today there
is no such thing:

- Access is a snapshot of GitHub repository IDs taken at sign-in and kept in
  the session for one hour (`sessions.repository_ids`). The user's GitHub
  token is discarded after sign-in, so the snapshot cannot be refreshed.
- Anyone who can see a repository on GitHub can turn Fletcher's reviews on or
  off for it (`POST /onboarding/repositories/:id`).
- Reinstalling the GitHub App creates a new installation ID, so anything tied
  to the installation (a trial counter, a key) would reset.

## 1. Context

This is not one endpoint. It is the tenancy and authorization layer for three
existing entry points:

| Entry point                                       | What changes                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub webhook receiver (`POST /webhooks/github`) | Installation events create or attach a workspace; organization and authorization events remove access                 |
| Sign-in (`GET /auth/callback`)                    | Creates memberships and derives each user's role from GitHub                                                          |
| Dashboard routes (SSR pages, the one form POST)   | Every read and write goes through a single policy check: workspace membership **and** GitHub access to the repository |

Callers are people in a browser (SSR pages and form posts) and GitHub
(webhooks, which retry on non-2xx for about 8 hours).

## 2. Data model

### Decision: one workspace per GitHub account, not per installation

A GitHub App can be installed at most once per account (user or
organization). Keying the workspace on the **immutable GitHub account ID**
means an uninstall and reinstall re-attach to the same workspace. The trial,
the key, and the plan survive, as `docs/PLAN.md` Phase 16 requires.

### Entities

```
workspaces
  id                    integer pk
  github_account_id     integer not null unique      -- immutable identity
  github_account_login  text not null                -- mutable, refreshed from events
  account_type          text not null                -- 'User' | 'Organization'
  created_at, updated_at

github_installations   (existing)
  + workspace_id        integer references workspaces(id)
                        -- nullable in SQL (D1 can't add a NOT NULL FK column
                        -- without rebuilding the table); the app always sets
                        -- it, and the backfill fills existing rows

memberships
  workspace_id          integer not null references workspaces(id) on delete cascade
  user_id               integer not null references users(id) on delete cascade
  github_owner          integer(boolean) not null default 0
                        -- derived from GitHub on every refresh; never set in-app
  app_role              text not null default 'member'   -- 'admin' | 'member'
                        -- set in-app by an owner; survives refreshes
  verified_at           timestamp not null           -- last time GitHub confirmed access
  created_at, updated_at
  primary key (workspace_id, user_id)
  check (app_role in ('admin', 'member'))

audit_events
  id                    integer pk
  workspace_id          integer not null references workspaces(id) on delete cascade
  actor_user_id         integer references users(id) on delete set null  -- null = GitHub/system
  action                text not null     -- 'role.changed', 'repository.reviews_toggled', ...
  target                text not null     -- e.g. 'user:12', 'repository:3'
  before, after         text              -- small JSON, never secrets
  created_at
  index (workspace_id, created_at)
```

**Effective role** = `owner` if `github_owner`, otherwise `app_role`.

### Roles come from GitHub where GitHub already knows

| Role   | Who                                                                                                                                                                                       | Can change in-app?           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| owner  | Personal account: the account holder (`user.github_user_id = workspace.github_account_id`). Organization: GitHub **org owners** (`role: "admin"` from `GET /user/memberships/orgs/{org}`) | No. Ownership follows GitHub |
| admin  | A member an owner promoted in-app                                                                                                                                                         | Yes, by an owner             |
| member | Anyone GitHub lists as able to reach at least one repository in the installation (`GET /user/installations`)                                                                              | Default                      |

This settles Phase 12's "ownership and owner-transfer rules": there is no
in-app transfer. To change owners, change them on GitHub, and the next
refresh reflects it. A workspace can briefly have zero owners (for example,
the last org owner left). Admins keep working, and owner-only actions wait.

### Invariants

1. Exactly one workspace per `github_account_id` (unique index).
2. A membership exists only while GitHub says the user can reach the
   installation. Refresh deletes memberships that GitHub no longer lists.
3. `github_owner` is only ever written by the GitHub-derived refresh.
4. Reading a repository still requires the user's GitHub access to **that
   repository**, not just workspace membership. An org member who can't see
   a private repository on GitHub doesn't see it here either.
5. Audit rows are append-only and never contain keys or tokens.

### Lifecycle

- **Workspace created**: when an installation is first synced (webhook or
  sign-in), upserted by `github_account_id`, with no members yet.
- **Membership created, updated, or deleted**: on sign-in and on each access
  refresh (section 4).
- **Installation removed**: the workspace stays (trial, key, plan, and history
  kept). Repositories are already marked removed by installation sync.
- **Workspace deleted**: Phase 15 (account deletion). Out of scope here.

### Migration and backfill (one additive migration)

1. Create `workspaces`, `memberships`, and `audit_events`. Add
   `github_installations.workspace_id`.
2. Backfill: insert one workspace per distinct `github_account_id` in
   `github_installations`, then set each installation's `workspace_id`.
3. Memberships are created lazily at each user's next sign-in. There's no
   backfill, because existing sessions carry no role data.

Safe under the existing deploy order: tables and columns are additive, and old
code ignores them.

## 3. Failure modes

| Failure                                                                                | Behavior                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub API unavailable during an access refresh                                        | Keep the last verified access until it is **60 minutes** old (today's session length), then fail closed: the next page asks the user to sign in again          |
| User revokes the app on GitHub (`github_app_authorization.revoked`, sent to every App) | Delete that user's sessions and memberships immediately                                                                                                        |
| User removed from the org (`organization.member_removed`, needs Members: read)         | Delete their membership in that workspace and revoke their sessions. Without the webhook, the next refresh catches it                                          |
| Installation webhook and sign-in race to create the same workspace                     | Both upsert on `github_account_id`. The unique index means one row, with no error                                                                              |
| Org renamed or user renamed                                                            | Account ID is the key. The login updates on the next event or sign-in                                                                                          |
| Last owner leaves the org                                                              | Workspace has no owner. Admins and members continue. Owner-only actions (roles, and later billing) show "An owner of the GitHub organization needs to sign in" |
| Owner demotes an admin while that admin submits a form                                 | Each POST re-reads the role from D1 before acting. Last write wins, and both writes are audited                                                                |
| Org requires approval for the new Members permission                                   | Owner check returns 403. Treat as "not an owner" and log it. Admins and members are unaffected                                                                 |
| Cross-site form post                                                                   | All POSTs go through one middleware: Origin must match, and `Sec-Fetch-Site` must not be `cross-site`. Replaces the per-route checks                           |

## 4. Authorization and permission refresh

**Principal**: the signed-in user (session). **Scope**: a workspace, plus
a repository for repository-level actions. **Enforcement point**: one policy
module, `authorize(access, action, target)`, called by every route before it
reads or writes. Queries also filter by workspace, so a missed check still
can't cross tenants.

| Action                                               | Required                                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| See a workspace, its repositories, and reviews       | member, and GitHub access to each repository shown   |
| Turn reviews on or off for a repository              | admin or owner, and GitHub access to that repository |
| Change workspace settings (and later the Gemini key) | admin or owner                                       |
| Promote or demote admins                             | owner                                                |
| Billing, delete workspace (later phases)             | owner                                                |

Responses: a resource the user can't see returns **404**, as today, so IDs
can't be probed. A visible resource with too little role returns **403**, with
a page that names the role needed and who holds it.

### Refreshing access (decided: Option A)

Access must stay current without a new sign-in. The hourly snapshot misses
new repositories and keeps removed access for up to an hour. Two ways to do
it:

**Option A: store the user's GitHub token, encrypted (chosen).**

- Keep the GitHub App user token and its refresh token on the session,
  encrypted with AES-GCM under a new `TOKEN_ENCRYPTION_KEY` Worker secret.
  They are never logged and are deleted on sign-out or expiry.
- When access is older than **10 minutes**, the next page load refreshes
  memberships and repository IDs in the background of that request. It costs
  about 2 + (number of installations) GitHub calls.
- Pros:
  - No visible redirects.
  - Webhooks and refresh can use the same code.
  - This is GitHub's documented pattern for App user tokens.
- Cons:
  - We now store a credential. If D1 leaked together with the encryption
    key, it would expose the user's GitHub App access (which is limited to
    what the App can do).

**Option B: silent re-sign-in, no stored token.**

- When access is older than 10 minutes, a GET page load redirects through
  GitHub sign-in. GitHub skips the prompt for an app that's already
  authorized, and the refresh happens in the callback.
- Pros: no stored credentials.
- Cons:
  - A redirect hop through github.com every 10 minutes. It can't happen on
    form POSTs or JSON API calls, which keep the old snapshot.
  - More moving parts in the sign-in flow.

Either way, webhooks give immediate revocation for app-authorization
revokes, org member removals, and installation changes.

### GitHub App settings this needs

- **Organization permissions → Members: Read-only**, to tell org owners from
  members and to receive `organization` events. Existing installs must
  accept the updated permissions on GitHub.
- Subscribe to the **Organization** event.
- Option A only: keep **"Expire user authorization tokens"** on (the default)
  so tokens are short-lived and refreshable.

## 5. Idempotence and concurrency

- **Workspace upsert**: keyed on `github_account_id`. Replays and races
  converge on one row.
- **Membership refresh**: a pure function of GitHub's answer. It upserts
  listed memberships (setting `github_owner` and `verified_at`), deletes
  unlisted ones, and never touches `app_role`. Running it twice gives the
  same result.
- **Role change** (`POST /workspaces/:id/members/:userId/role`, owner only):
  sets `app_role` to an absolute value ("admin" or "member"), not a toggle,
  so a double submit is harmless. The update and its audit row go in one
  D1 batch.
- **Out-of-order webhooks** (for example `member_removed` after a newer
  sign-in re-added the user): removal events delete only memberships whose
  `verified_at` is older than the event's delivery time.
- **Review switch**: already sets an absolute value. It gains a role check
  and an audit row in the same batch.

## 6. Observability

Structured logs through the existing `logInfo` / `logError` helpers. User IDs
and workspace IDs only, never tokens:

- `workspace_created`, `workspace_attached` (reinstall re-attached)
- `membership_refreshed` (added, updated, removed counts, duration),
  `membership_refresh_failed` (reason: `github_unavailable`, `token_revoked`,
  `owner_check_forbidden`)
- `authorization_denied` (action, role held, role needed). A spike means a
  bug or a probe.
- `access_revoked` (source: `webhook_app_revoked`, `webhook_member_removed`,
  `refresh_stale`)

`audit_events` is the user-facing record. A later settings page can show
"Andrew turned reviews off for not-my-tempo/app, 2 hours ago". No new
healthcheck: this adds no external dependency beyond GitHub, which sign-in
already uses.

## UI (Rehearsal Score design)

- **Dashboard** groups repositories under their workspace ("not-my-tempo",
  "neiman") with the user's role shown quietly beside the name.
- **Members page** at `/workspaces/:id/members`:
  - Lists members with their roles.
  - Owners are labeled "Owner on GitHub" and have no controls.
  - An owner sees "Make admin" and "Remove admin" buttons.
  - Empty and no-owner states say what to do.
- The review switch is shown only to admins and owners. Members see
  "Reviews on", with "Ask an admin to change this" on hover and focus.

## Build sequence (after approval)

1. Schema migration and backfill. Tests: backfill correctness, and
   uniqueness under concurrent upserts.
2. Workspace upsert inside installation sync. Membership sync at sign-in,
   including the org owner check.
3. Policy module and POST middleware, applied to the review switch. Tests:
   the full role × action matrix, and cross-workspace isolation for two users
   in two orgs with different repository access.
4. Access refresh (Option A or B), plus the `github_app_authorization` and
   `organization` webhooks.
5. Members page and role changes with audit rows.
6. Docs: README App settings (Members permission, Organization event),
   `.env.example` (`TOKEN_ENCRYPTION_KEY` if Option A), PLAN/PROGRESS.

Acceptance (from Phase 12):

- A renamed user keeps their account and roles.
- Revoked sessions and revoked app authorization stop working immediately.
- Removed org members lose access within 10 minutes, or immediately with the
  webhook.
- No user can read or change anything outside their workspace and their
  GitHub repository access.

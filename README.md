# Not Quite My Tempo

A pnpm monorepo boilerplate for a Cloudflare Worker API backed by D1, Hono, and Effect.

## Structure

```text
apps/
  api/                 Cloudflare Worker, Wrangler config, and tests
packages/
  core/                Platform-neutral Effect application primitives
  db/                  Effect layer for D1, Drizzle schemas, and migrations
```

## Versions

The workspace pins the versions researched on September 11, 2026:

| Package                     | Version   |
| --------------------------- | --------- |
| Hono                        | `4.13.7`  |
| Effect                      | `3.22.2`  |
| Wrangler                    | `4.131.0` |
| TypeScript                  | `7.0.2`   |
| Vite                        | `8.3.0`   |
| Vitest                      | `4.1.11`  |
| `@cloudflare/vitest-plugin` | `1.1.7`   |

The Cloudflare Vitest plugin currently peers on Vitest `4.1.x`, so this workspace uses the latest compatible Vitest line rather than Vitest 5.

## Development

Requirements: Node.js 22 or newer and pnpm 11.

Use `nvm install` and `nvm use` to select the pinned Node.js version in `.nvmrc`.
GitHub CI uses this version and runs lint, formatting, the dry-run build, and tests
on pushes and pull requests.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

The local Worker starts at `http://localhost:8787`.

The Worker requires `GITHUB_WEBHOOK_SECRET` to verify GitHub's HMAC-SHA256
webhook signature. `.env.example` documents the configuration and must be kept
in sync when variables are introduced or changed. D1 and the
`REVIEW_PULL_REQUEST_WORKFLOW` Workflow are configured as bindings in
`apps/api/wrangler.jsonc`.

## GitHub App credentials

Create a GitHub App and configure its repository permissions:

- **Pull requests: Read & write** to read PR metadata and post reviews.
- **Contents: Read-only** to fetch unified diffs from private repositories.
- Under **Subscribe to events**, enable **Pull request**.

For self-service onboarding, also set in the App's settings:

- **Callback URL**: `<worker-url>/auth/callback` (GitHub sign-in).
- **Setup URL**: `<worker-url>/onboarding/callback`, with **Redirect on
  update** enabled so repository changes return to onboarding too.
- Leave **Request user authorization (OAuth) during installation**
  unchecked; it disables the Setup URL.
- Set `GITHUB_APP_SLUG` to the App's URL name (`github.com/apps/<slug>`).
- Under **Organization permissions**, set **Members** to **Read-only**, and
  subscribe to the **Organization** event. Fletcher uses it to tell
  organization owners from members and to remove access when someone leaves
  the organization.

Workspaces can bring a Gemini key (a Gemini Developer API key from Google AI
Studio, or a Vertex AI API key in express mode) and pick any current model it
can use (Gemini 3.5+). Keys are checked against the provider's model list when
saved. OpenAI and Anthropic adapters exist but are off until verified against
the real APIs; `ENABLED_VENDORS` in `packages/reviewer/src/catalog.ts` turns
them on.
For a Vertex AI platform key, set `GEMINI_API_PROVIDER=vertex_express`.

Each workspace gets 5 free reviews on the platform `GEMINI_API_KEY`; after
that, reviews use the key an admin saves at `/workspaces/:id/settings`
(stored encrypted with `TOKEN_ENCRYPTION_KEY`). See
`docs/BYOK_TRIAL_DESIGN.md` and `docs/MULTI_PROVIDER_BYOK_DESIGN.md`.

Workspaces and roles are described in `docs/WORKSPACES_DESIGN.md`. Sessions
store the user's GitHub token encrypted with `TOKEN_ENCRYPTION_KEY` so
repository access can be re-checked every 10 minutes:

```sh
openssl rand -base64 32   # add to apps/api/.dev.vars as TOKEN_ENCRYPTION_KEY
pnpm --filter @not-quite-my-tempo/api exec wrangler secret put TOKEN_ENCRYPTION_KEY
```

The onboarding flow is sign in → `/onboarding` → install on GitHub → Setup
URL → a silent re-sign-in that verifies the new installation against the
user's own `GET /user/installations` list and syncs its repositories →
choose which repositories get reviews.

GitHub always delivers `installation` and `installation_repositories` events
to Apps. The Worker uses them to sync which repositories an installation can
access (listing them through `GET /installation/repositories`) and to stop
reviews for suspended or uninstalled installations and removed repositories.

Install the App on the repository to review. After changing permissions,
approve the updated permissions on the installation if GitHub prompts you.
Set the webhook URL to `<worker-or-tunnel-url>/webhooks/github` and use the
same webhook secret as `GITHUB_WEBHOOK_SECRET`.

The review bot authenticates as a GitHub App installation to read pull
request diffs and post reviews. Two secrets configure this
(`apps/api/src/github/app-auth.ts` consumes them):

- `GITHUB_APP_ID`: the numeric App ID from the GitHub App settings page.
- `GITHUB_APP_PRIVATE_KEY`: the App's private key in PKCS#8 PEM format.
  GitHub downloads keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`); convert first:

  ```sh
  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
    -in app.pem -out app.pkcs8.pem
  ```

Locally, add both to `apps/api/.dev.vars` (gitignored, never commit). In
production, store them as Worker secrets:

```sh
pnpm --filter @not-quite-my-tempo/api exec wrangler secret put GITHUB_APP_ID
pnpm --filter @not-quite-my-tempo/api exec wrangler secret put GITHUB_APP_PRIVATE_KEY
```

The service mints a short-lived RS256 App JWT with WebCrypto and exchanges it
for an installation token per review run inside the `review-pull-request`
Workflow.

## Model credentials

The review itself is performed by the `@not-quite-my-tempo/reviewer` package
(`packages/reviewer`), which calls Gemini's `generateContent`, OpenAI's
Responses API, or Anthropic's Messages API with structured JSON output and a
fixed review persona.

- `GEMINI_API_KEY` (required): add to `apps/api/.dev.vars` locally; in
  production store it as a Worker secret:

  ```sh
  pnpm --filter @not-quite-my-tempo/api exec wrangler secret put GEMINI_API_KEY
  ```

- `GEMINI_MODEL` (optional): the trial's model, overriding the default
  `gemini-3.8-flash`. Not a secret; set it under `vars` in
  `apps/api/wrangler.jsonc` if needed.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (optional secrets): platform keys
  that let the paid plan offer GPT and Claude models. Without one, that
  provider's models aren't offered on the plan. Ignored while only Gemini is
  enabled.
- `PLAN_MONTHLY_CREDITS` (optional): review credits per billing period on the
  paid plan (default 200).
- `TRIAL_DAILY_REVIEW_CAP` (optional): free trial reviews allowed per rolling
  24 hours across all workspaces (default 100; `0` pauses the trial). Past
  it, trial reviews fail with `trial_paused`, Fletcher comments once on the
  pull request, and `trial_daily_cap_reached` is logged as an error. Reviews
  on a workspace's own key or a paid plan are never capped. Also set a budget
  alert on the Google Cloud project behind `GEMINI_API_KEY`.

## Billing (Polar)

The paid plan includes 200 review credits per billing period on Fletcher's
platform keys, with Lite, Standard, and Pro Gemini models to choose from (see `docs/MULTI_PROVIDER_BYOK_DESIGN.md`, "Paid
plan credits"). Reviews on a workspace's own key never use credits. Polar
(polar.sh) is the merchant of record: it runs checkout, the customer portal,
and sales tax. Billing is optional and turns on only when the token, product,
and webhook secret are all set; otherwise settings pages show no Subscribe
button and workspaces stay on bring-your-own-key plus the trial.
See [docs/BILLING.md](docs/BILLING.md) for the full setup.

- `POLAR_ACCESS_TOKEN` (optional secret): an organization access token with
  `checkouts:write`, `customer_sessions:write`, `subscriptions:read`, and `products:read`.
- `POLAR_PRODUCT_ID` (optional): the recurring product for the paid plan.
- `POLAR_WEBHOOK_SECRET` (optional secret): the `whsec_…` secret of the
  webhook pointing at `/webhooks/polar`.
- `POLAR_SERVER` (optional): `sandbox` for sandbox.polar.sh; production by
  default.

```sh
pnpm --filter @not-quite-my-tempo/api exec wrangler secret put POLAR_ACCESS_TOKEN
pnpm --filter @not-quite-my-tempo/api exec wrangler secret put POLAR_WEBHOOK_SECRET
```

Lint and format the workspace with Oxlint and Oxfmt:

```sh
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

Both tools respect `.gitignore` and exclude generated Worker types. Oxfmt also excludes the generated pnpm lockfile.

The checked-in Wrangler config points at the production D1 database. Its `database_id` is not a secret (using it requires Cloudflare credentials), and local development and tests use their own local copies. Any `--remote` command, such as `pnpm db:migrate:remote`, runs against production. To use a separate database (a fork or a staging environment), create one and put its ID in `apps/api/wrangler.jsonc` or a Wrangler `env` block:

```sh
pnpm db:create
```

## Database

The D1 Effect service exposes the raw binding as `database` and the Drizzle client as `db`. The client is initialized from the Worker's D1 binding.

Drizzle Kit reads schema files from `packages/db/src/schema/**/*.ts` and writes SQL migrations to `packages/db/drizzle`. The initial schema covers GitHub installations, repositories, review runs, and findings. Use:

```sh
pnpm db:generate
pnpm db:migrate:local
pnpm db:migrate:remote
```

Migration application uses Wrangler authentication and the database configured in `apps/api/wrangler.jsonc`. The remote command requires a real database ID.

## Routes

```sh
curl http://localhost:8787/health
```

`POST /webhooks/github` accepts signed GitHub App webhook deliveries. It handles
the `opened`, `synchronize`, and `reopened` actions for the `pull_request` event.
Other event types and pull request actions return success without starting a
review, as do pull requests whose author isn't the repository `OWNER`, an org
`MEMBER`, or a `COLLABORATOR` (forks and drive-by contributors on public
repositories, which would otherwise spend the workspace's trial and daily
cap); a member can review those with `/fletcher again`. Supported deliveries upsert the GitHub installation and repository,
create one queued review run per repository, pull request number, and head SHA,
and start `review-pull-request`. The Workflow marks the run running, fetches the pull request metadata and unified
diff (filtering generated files and enforcing a size cap), reviews the diff
with the workspace's chosen model using structured JSON output, persists the
findings and model to
D1, posts the review to the pull request (a summary comment plus inline
comments anchored to changed lines, with posted comment IDs written back to
the findings), and marks the run completed. Each step that calls GitHub mints
its own installation token, so tokens never appear in persisted step
outputs. Failures record a stable
`error_code` (`github_auth_error`, `diff_fetch_error`, `diff_too_large`,
`review_error`, `review_output_invalid`, `review_key_rejected`,
`review_quota_exceeded`, `review_model_unavailable`, `review_key_unreadable`,
`post_review_error`, `db_error`, `review_run_not_found`, `no_gemini_key`,
`trial_paused`, `credits_exhausted`, or `workflow_error`) on the run. Runs
from before multi-provider support may carry `gemini_error`,
`gemini_key_rejected`, or `gemini_key_unreadable`.

Commenting `/fletcher again` on a pull request (via the `issue_comment`
event) triggers a `manual` review of the PR's current head SHA through the
same pipeline. Only comments whose author is the repository `OWNER`, an org
`MEMBER`, or a `COLLABORATOR` are honored. Idempotency still applies: if the
head SHA was already reviewed, the delivery reports `already_processed`.

## Per-repository configuration

Repositories may include a `.fletcher.json` at the root, read from the
default branch. Changes in a pull request take effect once merged, so a pull
request can't switch off or narrow its own review. All fields are optional; a missing or malformed file
falls back to defaults and never fails a review:

```json
{
  "enabled": true,
  "severityThreshold": "suggestion",
  "ignore": ["docs/**", "**/*.gen.ts"],
  "intensity": "studio_band",
  "tone": "standard"
}
```

- `enabled`: `false` skips the review entirely (the run completes with no
  findings and no comment).
- `severityThreshold`: minimum severity persisted and posted —
  `suggestion` (default, everything), `warning`, or `critical`.
- `ignore`: extra glob patterns merged with the built-in generated-file
  ignore list. Globs match the full path; `**` crosses directories, `*` and
  `?` do not.
- `intensity`: persona dial — `sectional` (dry, no theatrics), `studio_band`
  (default), or `carnegie` (maximum exactness).
- `tone`: who is reviewing — `standard` (default; the persona is seasoning
  on a businesslike review) or `ruthless` (full Terence Fletcher, backed by
  a principal engineer: interrogates every questionable choice, counts every
  repeat, gives fixes as orders, never says "good job"). Tone changes the
  voice only: findings, severities, confidence, and verdict follow the same
  rubric, and criticism stays on the code, never the person (no profanity,
  slurs, or threats). With `intensity: "sectional"`, ruthless becomes the
  quiet Fletcher; with `carnegie`, it also raises the bar.

Each installation is capped at 50 review runs per rolling 24 hours; deliveries
beyond the cap are acknowledged with `rate_limited` and no review is started.
Completed runs record the provider, model, token usage (`input_tokens`,
`output_tokens`, `total_tokens`), and their cost from the price catalog
(`cost_usd_micros`) for cost tracking.

## Dashboard API and sign-in

A session-gated, read-only JSON API backs the dashboard:

- `GET /auth/login` — redirects to GitHub OAuth (uses the GitHub App's OAuth
  client credentials). `GET /auth/callback` verifies the `state` cookie,
  exchanges the code, and persists the account using the immutable GitHub
  user ID. Username changes update the existing account. Repository access
  is discovered through paginated `GET /user/installations` and
  `GET /user/installations/{id}/repositories` calls with the user's token.
  Successful sign-in redirects to `/dashboard`.
- Sessions last one hour. The Secure, HttpOnly, SameSite=Lax cookie contains
  a random token; D1 stores only its HMAC-SHA256 hash (using `SESSION_SECRET`),
  user ID, expiry, and repository access snapshot. Legacy signed cookies
  are invalidated by this upgrade. GitHub OAuth access tokens are not stored.
- `POST /auth/logout` — requires a matching `Origin`, revokes the session
  in D1, and clears the cookie. The dashboard provides a sign-out form.
  `GET /auth/logout` returns 405 without changing the session.
- `GET /api/repositories` — known repositories the user can access, not all
  repositories belonging to an accessible installation.
- `GET /api/me` — the persistent account identity and current session expiry.
- `GET /api/repositories/:id/runs` — the latest review runs.
- `GET /api/runs/:id/findings` — findings for a run.
- `GET /api/usage` — run counts and token usage per repository.

Unknown and inaccessible resources both return 404. Requests without a valid
session return 401. Configure `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, and `SESSION_SECRET` (see `.env.example`), and
set the GitHub App's callback URL to `<worker-url>/auth/callback`.

Apply migration `0002_good_metal_master.sql` before running this version
(`pnpm db:migrate:local`, or `pnpm db:migrate:remote` for a configured remote
database). It adds `users` and `sessions` without changing existing reviews.

Repository permissions are a sign-in snapshot, valid for at most one hour;
changes on GitHub are not reflected immediately. Sign in again to refresh
access. Automatic permission refresh/revocation, workspace memberships, and
self-service installation onboarding remain required follow-up work before
public SaaS launch. Repositories still enter the local catalog through review
webhooks. Plans and billing are outside the current development scope.

A server-rendered dashboard sits on the same API at `/dashboard`: signed-out
visitors get a sign-in page; signed-in users see their repositories with run
counts and token usage, each repository's recent review runs (status,
trigger, error code, model, tokens), and each run's findings. Inaccessible
resources render a 404 page.

Deploy after the remote D1 database is configured:

```sh
pnpm deploy
```

## Test the GitHub webhook flow locally

1. Choose a webhook secret and create `apps/api/.dev.vars` (this file is local
   and must not be committed):

   ```dotenv
   GITHUB_WEBHOOK_SECRET=replace-with-a-random-local-secret
   GITHUB_APP_ID=replace-with-the-github-app-id
   GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...pkcs8 pem...\n-----END PRIVATE KEY-----"
   GEMINI_API_KEY=replace-with-a-gemini-api-key
   ```

2. Apply the schema and start the local Worker:

   ```sh
   pnpm db:migrate:local
   pnpm dev
   ```

3. Expose the running Worker to GitHub by pressing `t` in the Wrangler terminal.
   Copy the resulting `https://...trycloudflare.com` URL. Do not use
   `wrangler dev --remote`; Workflow bindings are not supported there.

4. In a GitHub App that is installed on the test repository, set the webhook
   URL to `<tunnel-url>/webhooks/github`, content type to `application/json`, and
   its secret to the exact value in `apps/api/.dev.vars`. Subscribe to pull
   request and issue comment events. A GitHub App delivery is required because
   the application expects the payload's `installation.id`.

5. Open a pull request in an installation repository. Re-push the branch to test
   `synchronize`, or close and reopen it to test `reopened`. Wrangler logs emit
   structured entries for receipt, review-run ID, Workflow start, and completion.

6. Inspect local orchestration and persisted state while `pnpm dev` is running:

   ```sh
   pnpm --filter @not-quite-my-tempo/api exec wrangler workflows instances list review-pull-request --local
   pnpm --filter @not-quite-my-tempo/api exec wrangler d1 execute DB --local --command "SELECT id, pull_request_number, head_sha, status, trigger FROM review_runs ORDER BY id DESC LIMIT 10"
   ```

   GitHub's **Redeliver** action for the same delivery must leave the table with
   one row for that repository, pull request number, and head SHA. The response
   remains HTTP 202 and reports `already_processed`.

For a quick signature check without GitHub, save a representative GitHub App
pull request payload as `/tmp/github-pull-request.json`, then run:

```sh
WEBHOOK_SECRET='replace-with-a-random-local-secret'
SIGNATURE="sha256=$(openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" /tmp/github-pull-request.json | awk '{print $2}')"
curl -i http://localhost:8787/webhooks/github \
  -H 'content-type: application/json' \
  -H 'x-github-event: pull_request' \
  -H "x-hub-signature-256: $SIGNATURE" \
  --data-binary @/tmp/github-pull-request.json
```

## Test the GitHub webhook flow after deployment

1. The production D1 database already exists (its ID is in
   `apps/api/wrangler.jsonc`). For a new deployment, create one, put its ID
   there, and apply the migrations:

   ```sh
   pnpm db:create
   pnpm db:migrate:remote
   ```

2. Store a strong secret in Cloudflare and deploy. Enter the value only at
   Wrangler's prompt; use the same value in GitHub:

   ```sh
   pnpm --filter @not-quite-my-tempo/api exec wrangler secret put GITHUB_WEBHOOK_SECRET
   pnpm deploy
   ```

3. Set the GitHub App webhook URL to the deployed Worker URL followed by
   `/webhooks/github`, select `application/json`, configure the matching secret,
   subscribe to pull request and issue comment events, and install the app on
   the test repository.

4. Open a pull request and confirm its delivery received HTTP 202 in GitHub's
   **Recent deliveries**. In separate terminals, inspect Cloudflare logs,
   Workflow instances, and D1:

   ```sh
   pnpm --filter @not-quite-my-tempo/api exec wrangler tail
   pnpm --filter @not-quite-my-tempo/api exec wrangler workflows instances list review-pull-request
   pnpm --filter @not-quite-my-tempo/api exec wrangler d1 execute DB --remote --command "SELECT id, pull_request_number, head_sha, status, trigger FROM review_runs ORDER BY id DESC LIMIT 10"
   ```

   The newest run should transition from `queued` to `running` to `completed`.
   Redelivering the same GitHub delivery must not add another row.

## References

- [Drizzle: Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
- [Cloudflare: Query D1 from Hono](https://developers.cloudflare.com/d1/examples/d1-and-hono/)
- [Cloudflare: TypeScript Workers and generated types](https://developers.cloudflare.com/workers/languages/typescript/)
- [Cloudflare: Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare Workflows: Local development](https://developers.cloudflare.com/workflows/build/local-development/)
- [Cloudflare Workflows: Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Effect: Using generators](https://effect.website/docs/getting-started/using-generators/)
- [GitHub: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [pnpm: Workspaces](https://pnpm.io/workspaces)

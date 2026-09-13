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

## Gemini credentials

The review itself is performed by the Gemini API through the
`@not-quite-my-tempo/gemini` package (`packages/gemini`), which calls
`generateContent` with structured JSON output and a fixed review persona.

- `GEMINI_API_KEY` (required): add to `apps/api/.dev.vars` locally; in
  production store it as a Worker secret:

  ```sh
  pnpm --filter @not-quite-my-tempo/api exec wrangler secret put GEMINI_API_KEY
  ```

- `GEMINI_MODEL` (optional): overrides the default `gemini-3.8-flash`. Not a
  secret; set it under `vars` in `apps/api/wrangler.jsonc` if needed.

Lint and format the workspace with Oxlint and Oxfmt:

```sh
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

Both tools respect `.gitignore` and exclude generated Worker types. Oxfmt also excludes the generated pnpm lockfile.

The checked-in Wrangler config uses a deterministic all-zero D1 UUID so local development and tests work before a Cloudflare database exists. Create a real database before using remote commands:

```sh
pnpm db:create
```

Copy the returned `database_id` into `apps/api/wrangler.jsonc`, replacing the all-zero UUID. The Worker only declares the binding; no application data or database routes are included.

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
review. Supported deliveries upsert the GitHub installation and repository,
create one queued review run per repository, pull request number, and head SHA,
and start `review-pull-request`. The Workflow marks the run running, mints a
GitHub App installation token, fetches the pull request metadata and unified
diff (filtering generated files and enforcing a size cap), reviews the diff
with Gemini using structured JSON output, persists the findings and model to
D1, posts the review to the pull request (a summary comment plus inline
comments anchored to changed lines, with posted comment IDs written back to
the findings), and marks the run completed. Failures record a stable
`error_code` (`github_auth_error`, `diff_fetch_error`, `diff_too_large`,
`gemini_error`, `post_review_error`, `db_error`, `review_run_not_found`, or
`workflow_error`) on the run.

Commenting `/fletcher again` on a pull request (via the `issue_comment`
event) triggers a `manual` review of the PR's current head SHA through the
same pipeline. Only comments whose author is the repository `OWNER`, an org
`MEMBER`, or a `COLLABORATOR` are honored. Idempotency still applies: if the
head SHA was already reviewed, the delivery reports `already_processed`.

## Per-repository configuration

Repositories may include a `.fletcher.json` at the root (read from the pull
request's head SHA). All fields are optional; a missing or malformed file
falls back to defaults and never fails a review:

```json
{
  "enabled": true,
  "severityThreshold": "suggestion",
  "ignore": ["docs/**", "**/*.gen.ts"],
  "intensity": "studio_band"
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

Each installation is capped at 50 review runs per rolling 24 hours; deliveries
beyond the cap are acknowledged with `rate_limited` and no review is started.
Completed runs record the Gemini model and token usage (`input_tokens`,
`output_tokens`, `total_tokens`) for cost tracking.

## Dashboard API and sign-in

A session-gated, read-only JSON API backs the (upcoming) dashboard:

- `GET /auth/login` — redirects to GitHub OAuth (uses the GitHub App's OAuth
  client credentials). `GET /auth/callback` verifies the `state` cookie,
  exchanges the code, resolves the user's installations via
  `GET /user/installations`, and sets a signed HttpOnly session cookie
  (7-day HMAC-SHA256, `SESSION_SECRET`). `GET /auth/logout` clears it.
- `GET /api/repositories` — repositories in the user's installations.
- `GET /api/repositories/:id/runs` — the latest review runs.
- `GET /api/runs/:id/findings` — findings for a run.
- `GET /api/usage` — run counts and token usage per repository.

Unknown and inaccessible resources both return 404. Requests without a valid
session return 401. Configure `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, and `SESSION_SECRET` (see `.env.example`), and
set the GitHub App's callback URL to `<worker-url>/auth/callback`.

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

1. Create the production D1 database once, replace the placeholder
   `database_id` in `apps/api/wrangler.jsonc` with the returned ID, and apply the
   migrations:

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

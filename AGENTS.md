# AGENTS.md

## Commands (repo root; pnpm 11, Node per `.nvmrc`)

- Setup: `nvm use` (or `nvm install`), `pnpm install`.
- Verify, mirroring CI order (`.github/workflows/ci.yml`): `pnpm lint` → `pnpm format:check` → `pnpm build` (Wrangler dry-run deploy) → `pnpm test`. Also run `pnpm typecheck` (`pnpm typecheck:test` covers `apps/api/test/`); CI does not run `tsc`.
- Fix/format: `pnpm lint:fix`, `pnpm format`.
- Single test: `pnpm --filter @not-quite-my-tempo/api exec vitest run test/<name>.test.ts`.
- Dev: `pnpm db:migrate:local`, then `pnpm dev` (Worker at `http://localhost:8787`).
- DB: `pnpm db:generate` (schema → `packages/db/drizzle`), `pnpm db:migrate:local` / `pnpm db:migrate:remote`, `pnpm db:create` (new D1 DB). Regenerate Worker types with `pnpm db:types` — never hand-edit `apps/api/worker-configuration.d.ts` (excluded from lint/format).

## Architecture

- `apps/api/src/index.ts` is the only entrypoint (Hono app, default export; also exports `ReviewPullRequestWorkflow`). Routes delegate to Effect via `Effect.runPromise` + `makeLiveLayer(c.env.DB)`.
- `packages/core`: platform-neutral Effect primitives. `packages/db`: D1/Drizzle layer — schema in `src/schema/**/*.ts`, Effect services in `src/services/`, `src/layers/`, `src/repositories/`. Both are consumed as source via `workspace:*` + `exports` → `src/*.ts` (no build step).
- Bindings live in `apps/api/wrangler.jsonc`: D1 `DB` (migrations dir `../../packages/db/drizzle`) and Workflow `REVIEW_PULL_REQUEST_WORKFLOW` / `review-pull-request`. `compatibility_date` 2026-09-10.

## Gotchas

- `wrangler.jsonc` ships an all-zero D1 `database_id` placeholder that works locally. After `pnpm db:create`, paste the real ID before any `--remote` command.
- Secrets: local-only `apps/api/.dev.vars` (gitignored, never commit), prod via `wrangler secret put GITHUB_WEBHOOK_SECRET`. When adding/changing/removing env vars, update root `.env.example` in the same change (purpose, required/optional, where loaded; empty values only) and keep README setup in sync.
- Never use `wrangler dev --remote` — Workflow bindings break there. For webhook tunnels, press `t` in the `wrangler dev` terminal.
- Tests run in workerd via `@cloudflare/vitest-plugin`; keep Vitest on `4.1.x` (the plugin's peer range, not v5). `test/setup.ts` hardcodes applying `packages/db/drizzle/0000_*.sql` — extend it when a second migration lands. Reuse `resetAndSeedRepository` in `test/database.ts` (FK-safe delete order, seeds installation 1 / repo 1).
- TypeScript is strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` → use `import type`). Effect is v3 (`3.22.2`), not v4. Oxlint runs with `--deny-warnings` plus local `anti-slop` / `anti-slop-effect` plugins (`tools/oxlint/anti-slop`, itself excluded) — follow the Effect idioms they enforce instead of weakening rules. Oxfmt width is 80.

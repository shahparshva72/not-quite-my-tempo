# Not Quite My Tempo

A pnpm monorepo boilerplate for a Cloudflare Worker API backed by D1, Hono, and Effect.

## Structure

```text
apps/
  api/                 Cloudflare Worker, Wrangler config, and tests
packages/
  core/                Platform-neutral Effect application primitives
  d1/                  Effect layer for D1 and Drizzle ORM, migration configuration
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

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

The local Worker starts at `http://localhost:8787`.

The current application requires no environment variables. `.env.example` documents
the configuration and must be kept in sync when variables are introduced or
changed. D1 is configured through the `DB` binding in `apps/api/wrangler.jsonc`.

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

Drizzle Kit is configured to read future schema files from `packages/d1/src/schema/**/*.ts` and write SQL migrations to `packages/d1/migrations`. No schemas or migrations are included. Once you add your schema, use:

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

Deploy after the remote D1 database is configured:

```sh
pnpm deploy
```

## References

- [Drizzle: Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
- [Cloudflare: Query D1 from Hono](https://developers.cloudflare.com/d1/examples/d1-and-hono/)
- [Cloudflare: TypeScript Workers and generated types](https://developers.cloudflare.com/workers/languages/typescript/)
- [Cloudflare: Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Effect: Using generators](https://effect.website/docs/getting-started/using-generators/)
- [pnpm: Workspaces](https://pnpm.io/workspaces)

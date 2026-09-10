# Not Quite My Tempo

A pnpm monorepo boilerplate for a Cloudflare Worker API backed by D1, Hono, and Effect.

## Structure

```text
apps/
  api/                 Cloudflare Worker, Wrangler config, and tests
packages/
  core/                Platform-neutral Effect application primitives
  d1/                  Effect layer for the Cloudflare D1 binding
```

## Versions

The workspace pins the versions researched on September 11, 2026:

| Package | Version |
| --- | --- |
| Hono | `4.13.7` |
| Effect | `3.22.2` |
| Wrangler | `4.131.0` |
| TypeScript | `7.0.2` |
| Vite | `8.3.0` |
| Vitest | `4.1.11` |
| `@cloudflare/vitest-plugin` | `1.1.7` |

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

The checked-in Wrangler config uses a deterministic all-zero D1 UUID so local development and tests work before a Cloudflare database exists. Create a real database before using remote commands:

```sh
pnpm db:create
```

Copy the returned `database_id` into `apps/api/wrangler.jsonc`, replacing the all-zero UUID. The Worker only declares the binding; no application data or database routes are included.

## Routes

```sh
curl http://localhost:8787/health
```

Deploy after the remote D1 database is configured:

```sh
pnpm deploy
```

## References

- [Cloudflare: Query D1 from Hono](https://developers.cloudflare.com/d1/examples/d1-and-hono/)
- [Cloudflare: TypeScript Workers and generated types](https://developers.cloudflare.com/workers/languages/typescript/)
- [Cloudflare: Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Effect: Using generators](https://effect.website/docs/getting-started/using-generators/)
- [pnpm: Workspaces](https://pnpm.io/workspaces)

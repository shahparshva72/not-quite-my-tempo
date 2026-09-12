import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

import migration from "../../../packages/db/drizzle/0000_spooky_kinsey_walden.sql?raw";

beforeAll(async () => {
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => env.DB.prepare(statement));

  await env.DB.batch(statements);
});

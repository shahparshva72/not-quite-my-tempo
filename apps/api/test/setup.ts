import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

import migration0000 from "../../../packages/db/drizzle/0000_spooky_kinsey_walden.sql?raw";
import migration0001 from "../../../packages/db/drizzle/0001_abandoned_lorna_dane.sql?raw";

const migrations = [migration0000, migration0001];

beforeAll(async () => {
  const statements = migrations.flatMap((migration) =>
    migration.split("--> statement-breakpoint").flatMap((statement) => {
      const trimmed = statement.trim();

      return trimmed === "" ? [] : [env.DB.prepare(trimmed)];
    }),
  );

  await env.DB.batch(statements);
});

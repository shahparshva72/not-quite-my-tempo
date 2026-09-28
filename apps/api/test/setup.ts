import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

import migration0000 from "../../../packages/db/drizzle/0000_spooky_kinsey_walden.sql?raw";
import migration0001 from "../../../packages/db/drizzle/0001_abandoned_lorna_dane.sql?raw";
import migration0002 from "../../../packages/db/drizzle/0002_good_metal_master.sql?raw";
import migration0003 from "../../../packages/db/drizzle/0003_opposite_union_jack.sql?raw";
import migration0004 from "../../../packages/db/drizzle/0004_loud_may_parker.sql?raw";
import migration0005 from "../../../packages/db/drizzle/0005_brown_black_knight.sql?raw";
import migration0006 from "../../../packages/db/drizzle/0006_backfill_workspaces.sql?raw";
import migration0007 from "../../../packages/db/drizzle/0007_big_iron_monger.sql?raw";

const migrations = [
  migration0000,
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
];

beforeAll(async () => {
  const statements = migrations.flatMap((migration) =>
    migration.split("--> statement-breakpoint").flatMap((statement) => {
      const trimmed = statement.trim();

      return trimmed === "" ? [] : [env.DB.prepare(trimmed)];
    }),
  );

  await env.DB.batch(statements);
});

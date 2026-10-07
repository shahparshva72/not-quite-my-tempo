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
import migration0008 from "../../../packages/db/drizzle/0008_sour_roughhouse.sql?raw";
import migration0009 from "../../../packages/db/drizzle/0009_freezing_grey_gargoyle.sql?raw";
import migration0010 from "../../../packages/db/drizzle/0010_awesome_jack_flag.sql?raw";
import migration0011 from "../../../packages/db/drizzle/0011_uneven_captain_universe.sql?raw";
import migration0012 from "../../../packages/db/drizzle/0012_sad_drax.sql?raw";
import migration0013 from "../../../packages/db/drizzle/0013_fluffy_lenny_balinger.sql?raw";
import migration0014 from "../../../packages/db/drizzle/0014_fantastic_daimon_hellstrom.sql?raw";
import migration0015 from "../../../packages/db/drizzle/0015_low_the_order.sql?raw";
import migration0016 from "../../../packages/db/drizzle/0016_violet_marauders.sql?raw";
import migration0017 from "../../../packages/db/drizzle/0017_legal_blob.sql?raw";

const migrations = [
  migration0000,
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
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

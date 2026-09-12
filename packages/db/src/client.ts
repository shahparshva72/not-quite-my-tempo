import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import * as schema from "./schema/index.js";

export type DatabaseClient = DrizzleD1Database<typeof schema>;

export const drizzleClient = (database: D1Database): DatabaseClient =>
  drizzle(database, { schema });

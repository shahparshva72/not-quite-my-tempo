import type { D1Database } from "@cloudflare/workers-types";
import { Context, Layer } from "effect";

import { makeDatabaseClient } from "../client.js";
import type { DatabaseClient } from "../client.js";

export interface DatabaseService {
  readonly client: DatabaseClient;
}

export class Database extends Context.Tag("@not-quite-my-tempo/db/Database")<
  Database,
  DatabaseService
>() {}

export const DatabaseLive = (database: D1Database): Layer.Layer<Database> =>
  Layer.succeed(Database, { client: makeDatabaseClient(database) });

import type { D1Database } from "@cloudflare/workers-types";
import { Layer } from "effect";

import { ReviewRunRepositoryLive } from "../repositories/review-run-repository.js";
import { DatabaseLive } from "../services/database.js";

export const makeLiveLayer = (database: D1Database) =>
  ReviewRunRepositoryLive.pipe(Layer.provide(DatabaseLive(database)));

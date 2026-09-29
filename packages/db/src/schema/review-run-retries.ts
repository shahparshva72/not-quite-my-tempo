import { sql } from "drizzle-orm";
import { index, integer, sqliteTable } from "drizzle-orm/sqlite-core";

import { reviewRuns } from "./review-runs.js";

// One row per "/fletcher again" retry of a failed run. A retry reuses the
// run's row, so the daily review cap counts these alongside new runs.
export const reviewRunRetries = sqliteTable(
  "review_run_retries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reviewRunId: integer("review_run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("review_run_retries_created_at_idx").on(table.createdAt),
    index("review_run_retries_review_run_id_idx").on(table.reviewRunId),
  ],
);

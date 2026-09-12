import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { reviewRuns } from "./review-runs.js";

export const findingSeverities = ["critical", "warning", "suggestion"] as const;

export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reviewRunId: integer("review_run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    line: integer("line"),
    severity: text("severity", { enum: findingSeverities }).notNull(),
    category: text("category"),
    confidence: real("confidence"),
    title: text("title"),
    message: text("message").notNull(),
    githubCommentId: integer("github_comment_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("findings_review_run_id_idx").on(table.reviewRunId),
    check(
      "findings_severity_check",
      sql`${table.severity} in ('critical', 'warning', 'suggestion')`,
    ),
  ],
);

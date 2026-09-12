import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { repositories } from "./repositories.js";

export const reviewRunStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const reviewRunTriggers = [
  "opened",
  "synchronize",
  "reopened",
  "manual",
] as const;

export const reviewRuns = sqliteTable(
  "review_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pullRequestNumber: integer("pull_request_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status", { enum: reviewRunStatuses }).notNull(),
    trigger: text("trigger", { enum: reviewRunTriggers }).notNull(),
    model: text("model"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("review_runs_repository_pr_head_unique").on(
      table.repositoryId,
      table.pullRequestNumber,
      table.headSha,
    ),
    index("review_runs_repository_id_idx").on(table.repositoryId),
    check(
      "review_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "review_runs_trigger_check",
      sql`${table.trigger} in ('opened', 'synchronize', 'reopened', 'manual')`,
    ),
  ],
);

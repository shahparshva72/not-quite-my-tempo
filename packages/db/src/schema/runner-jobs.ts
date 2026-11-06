import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { reviewRuns } from "./review-runs.js";

export const runnerJobStatuses = [
  "issued",
  "claimed",
  "completed",
  "expired",
] as const;

/**
 * One review handed to a repository's own GitHub Actions. The review
 * Workflow issues it and waits; the runner claims it (proving with a GitHub
 * Actions OIDC token that it runs in that repository), reviews on its own
 * credentials, and reports the result, which resumes the Workflow.
 */
export const runnerJobs = sqliteTable(
  "runner_jobs",
  {
    // Random and unguessable, though every call also needs a valid OIDC
    // token for the job's repository.
    id: text("id").primaryKey(),
    reviewRunId: integer("review_run_id")
      .notNull()
      .unique()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    workflowInstanceId: text("workflow_instance_id").notNull(),
    githubRepositoryId: integer("github_repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    headSha: text("head_sha").notNull(),
    // The run's ReviewRequest as JSON, so a claim can rebuild the prompt
    // without the Workflow's parameters.
    request: text("request").notNull(),
    status: text("status", { enum: runnerJobStatuses }).notNull(),
    // The GitHub Actions run that claimed the job; only it may report.
    githubRunId: text("github_run_id"),
    githubRunAttempt: text("github_run_attempt"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("runner_jobs_lookup_idx").on(
      table.githubRepositoryId,
      table.pullRequestNumber,
      table.headSha,
    ),
    check(
      "runner_jobs_status_check",
      sql`${table.status} in ('issued', 'claimed', 'completed', 'expired')`,
    ),
  ],
);

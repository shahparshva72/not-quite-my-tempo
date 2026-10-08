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
import { workspaces } from "./workspaces.js";

export const reviewRunStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

// Mirrors ReviewVerdict in @not-quite-my-tempo/reviewer (kept dependency-free).
export const reviewVerdicts = ["not_my_tempo", "almost", "good_job"] as const;

// Which Gemini key a run used; null when it never reached Gemini.
// "platform" is a free trial review; "subscription" is the platform key on
// a paid plan and never counts against the trial.
export const reviewKeySources = [
  "workspace",
  "platform",
  "subscription",
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
    // Set with the model when Gemini returns a review; null for runs that
    // were skipped, failed, or predate verdict storage.
    verdict: text("verdict", { enum: reviewVerdicts }),
    summary: text("summary"),
    keySource: text("key_source", { enum: reviewKeySources }),
    // Which API ran the review (ReviewProvider); null when none did.
    provider: text("provider"),
    // On a paid-plan run: the model the workspace had picked, when the run
    // switched to a smaller one because credits ran low.
    requestedModel: text("requested_model"),
    // Paid-plan credits this run claimed, × 100 so sums stay exact
    // (docs/MULTI_PROVIDER_BYOK_DESIGN.md, "Paid plan credits").
    creditsX100: integer("credits_x100"),
    // The workspace and billing period charged, fixed at claim time like
    // trialWorkspaceId.
    creditsWorkspaceId: integer("credits_workspace_id").references(
      () => workspaces.id,
      { onDelete: "set null" },
    ),
    creditsPeriodStart: integer("credits_period_start", {
      mode: "timestamp_ms",
    }),
    // What the model call cost us, from tokens × catalog price.
    costUsdMicros: integer("cost_usd_micros"),
    // The workspace whose free trial this run used, fixed when it claims
    // one, so repository transfers can't move trial history between
    // workspaces.
    trialWorkspaceId: integer("trial_workspace_id").references(
      () => workspaces.id,
      { onDelete: "set null" },
    ),
    // Bumped when "/fletcher again" retries a failed run on the same
    // commit; part of the Workflow instance ID, which can't be reused.
    attempt: integer("attempt").notNull().default(1),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
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
    index("review_runs_credits_period_idx").on(
      table.creditsWorkspaceId,
      table.creditsPeriodStart,
    ),
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

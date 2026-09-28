import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { workspaces } from "./workspaces.js";

// "suspended" and "removed" installations keep their history but must not
// start new reviews; GitHub's installation webhooks drive the transitions.
export const githubInstallationStatuses = [
  "active",
  "suspended",
  "removed",
] as const;

export const githubInstallations = sqliteTable("github_installations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubInstallationId: integer("github_installation_id").notNull().unique(),
  githubAccountId: integer("github_account_id").notNull(),
  githubAccountLogin: text("github_account_login").notNull(),
  accountType: text("account_type").notNull(),
  // Nullable in SQL because D1 can't add a NOT NULL foreign key column in
  // place; installation sync always sets it and migration 0006 backfills.
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  status: text("status", { enum: githubInstallationStatuses })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

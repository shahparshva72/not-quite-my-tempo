import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One workspace per GitHub account (user or organization), keyed on the
// immutable account ID so reinstalling the App re-attaches to it. See
// docs/WORKSPACES_DESIGN.md.
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubAccountId: integer("github_account_id").notNull().unique(),
  githubAccountLogin: text("github_account_login").notNull(),
  accountType: text("account_type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const githubInstallations = sqliteTable("github_installations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubInstallationId: integer("github_installation_id").notNull().unique(),
  githubAccountId: integer("github_account_id").notNull(),
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

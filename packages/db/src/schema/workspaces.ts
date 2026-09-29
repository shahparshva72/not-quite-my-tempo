import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

// One workspace per GitHub account (user or organization), keyed on the
// immutable account ID so reinstalling the App re-attaches to it. See
// docs/WORKSPACES_DESIGN.md.
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubAccountId: integer("github_account_id").notNull().unique(),
  githubAccountLogin: text("github_account_login").notNull(),
  accountType: text("account_type").notNull(),
  // The workspace's own Gemini key, AES-GCM encrypted with
  // TOKEN_ENCRYPTION_KEY (context "workspace:<id>:gemini"). Only last4 is
  // ever shown. See docs/BYOK_TRIAL_DESIGN.md.
  geminiKeyCiphertext: text("gemini_key_ciphertext"),
  geminiKeyLast4: text("gemini_key_last4"),
  geminiKeyUpdatedAt: integer("gemini_key_updated_at", {
    mode: "timestamp_ms",
  }),
  geminiKeyUpdatedBy: integer("gemini_key_updated_by").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  // Platform-key reviews used from the free trial; taken atomically.
  trialReviewsUsed: integer("trial_reviews_used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

// One workspace per GitHub account (user or organization), keyed on the
// immutable account ID so reinstalling the App re-attaches to it. See
// docs/WORKSPACES_DESIGN.md.
// Which Google API the workspace key works with; see GeminiProvider in
// @not-quite-my-tempo/gemini (kept dependency-free).
export const geminiKeyProviders = ["gemini_api", "vertex_express"] as const;

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
  geminiKeyProvider: text("gemini_key_provider", { enum: geminiKeyProviders }),
  geminiKeyUpdatedAt: integer("gemini_key_updated_at", {
    mode: "timestamp_ms",
  }),
  geminiKeyUpdatedBy: integer("gemini_key_updated_by").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  // The workspace's Polar subscription as Fletcher last read it from
  // Polar's API (docs/BILLING.md). Webhooks only trigger that read, so
  // these never come from a webhook payload. subscriptionStatus is Polar's
  // raw status ("active", "past_due", "canceled", ...); only active and
  // trialing count as paid. subscriptionSyncedAt is when the read started,
  // so a slower, older read never overwrites a newer one.
  polarCustomerId: text("polar_customer_id"),
  polarSubscriptionId: text("polar_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  subscriptionPeriodEnd: integer("subscription_period_end", {
    mode: "timestamp_ms",
  }),
  subscriptionCancelAtPeriodEnd: integer("subscription_cancel_at_period_end", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  subscriptionSyncedAt: integer("subscription_synced_at", {
    mode: "timestamp_ms",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

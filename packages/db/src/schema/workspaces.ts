import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

// One workspace per GitHub account (user or organization), keyed on the
// immutable account ID so reinstalling the App re-attaches to it. See
// docs/WORKSPACES_DESIGN.md.
// Which API the workspace's own key works with; mirrors ReviewProvider in
// @not-quite-my-tempo/reviewer (kept dependency-free). The column kept its
// original name when OpenAI and Anthropic keys were added.
export const reviewKeyProviders = [
  "gemini_api",
  "vertex_express",
  "openai",
  "anthropic",
] as const;

export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubAccountId: integer("github_account_id").notNull().unique(),
  githubAccountLogin: text("github_account_login").notNull(),
  accountType: text("account_type").notNull(),
  // The workspace's own review key (Gemini, OpenAI, or Anthropic; the
  // gemini_key_* names predate the other providers), AES-GCM encrypted
  // with TOKEN_ENCRYPTION_KEY (context "workspace:<id>:gemini" for Google
  // keys, "workspace:<id>:<provider>" otherwise). Only last4 is ever shown.
  // See docs/BYOK_TRIAL_DESIGN.md and docs/MULTI_PROVIDER_BYOK_DESIGN.md.
  geminiKeyCiphertext: text("gemini_key_ciphertext"),
  geminiKeyLast4: text("gemini_key_last4"),
  geminiKeyProvider: text("gemini_key_provider", { enum: reviewKeyProviders }),
  geminiKeyUpdatedAt: integer("gemini_key_updated_at", {
    mode: "timestamp_ms",
  }),
  geminiKeyUpdatedBy: integer("gemini_key_updated_by").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  // The model own-key reviews use; null means the provider's default.
  reviewModel: text("review_model"),
  // The paid plan's model (a catalog model); null means the plan default.
  planModel: text("plan_model"),
  // The workspace's Polar subscription as Fletcher last read it from
  // Polar's API (docs/BILLING.md). Webhooks only trigger that read, so
  // these never come from a webhook payload. subscriptionStatus is Polar's
  // raw status ("active", "past_due", "canceled", ...); only active and
  // trialing count as paid. subscriptionSyncedAt is when the read started,
  // so a slower, older read never overwrites a newer one.
  polarCustomerId: text("polar_customer_id"),
  polarSubscriptionId: text("polar_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  subscriptionPeriodStart: integer("subscription_period_start", {
    mode: "timestamp_ms",
  }),
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

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryIds: text("repository_ids").notNull(),
    // The user's GitHub token, AES-GCM encrypted with TOKEN_ENCRYPTION_KEY,
    // used only to refresh repositoryIds and memberships. Null for sessions
    // created before access refresh existed; those simply expire.
    githubTokenCiphertext: text("github_token_ciphertext"),
    accessVerifiedAt: integer("access_verified_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

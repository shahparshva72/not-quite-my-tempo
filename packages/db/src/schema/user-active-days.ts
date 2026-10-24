import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

// The UTC days each user opened a signed-in page: enough to count weekly
// users and returning users, and nothing about what they looked at.
// Deleted with the account, and pruned after a retention window.
export const userActiveDays = sqliteTable(
  "user_active_days",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // A UTC calendar date, e.g. 2026-10-20.
    day: text("day").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day] }),
    index("user_active_days_day_idx").on(table.day),
  ],
);

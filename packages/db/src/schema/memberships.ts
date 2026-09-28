import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const membershipAppRoles = ["admin", "member"] as const;

// Effective role is "owner" when githubOwner is set, otherwise appRole.
// githubOwner is only written by the GitHub-derived access refresh; appRole
// is only written by an owner in-app, so refreshes never undo promotions.
export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubOwner: integer("github_owner", { mode: "boolean" })
      .notNull()
      .default(false),
    appRole: text("app_role", { enum: membershipAppRoles })
      .notNull()
      .default("member"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("memberships_user_id_idx").on(table.userId),
    check(
      "memberships_app_role_check",
      sql`${table.appRole} in ('admin', 'member')`,
    ),
  ],
);

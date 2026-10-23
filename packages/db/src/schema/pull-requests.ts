import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { repositories } from "./repositories.js";

export const pullRequestStates = ["open", "closed", "merged"] as const;

// The latest GitHub details of a pull request, so pages can name it
// instead of showing only its number. Kept current by pull_request
// webhooks; review runs find it by repository and number.
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    authorLogin: text("author_login").notNull(),
    headRef: text("head_ref").notNull(),
    baseRef: text("base_ref").notNull(),
    state: text("state", { enum: pullRequestStates }).notNull(),
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    // GitHub's updated_at for these details. Deliveries can arrive out of
    // order, so an older one never overwrites a newer one.
    githubUpdatedAt: integer("github_updated_at", {
      mode: "timestamp_ms",
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("pull_requests_repository_number_unique").on(
      table.repositoryId,
      table.number,
    ),
    check(
      "pull_requests_state_check",
      sql`${table.state} in ('open', 'closed', 'merged')`,
    ),
  ],
);

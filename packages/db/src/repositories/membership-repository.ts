import { and, eq, lt, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { auditEvents } from "../schema/audit-events.js";
import { memberships } from "../schema/memberships.js";
import { users } from "../schema/users.js";
import { workspaces } from "../schema/workspaces.js";
import { Database } from "../services/database.js";

export type Membership = typeof memberships.$inferSelect;

export type Workspace = typeof workspaces.$inferSelect;

export type WorkspaceRole = "owner" | "admin" | "member";

/** GitHub's answer for one workspace the user can reach. */
export interface VerifiedMembership {
  readonly workspaceId: number;
  readonly githubOwner: boolean;
}

export interface WorkspaceMembership {
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
  readonly verifiedAt: Date;
}

export interface WorkspaceMember {
  readonly userId: number;
  readonly login: string;
  readonly role: WorkspaceRole;
  readonly verifiedAt: Date;
}

export interface RoleChange {
  readonly workspaceId: number;
  readonly targetUserId: number;
  readonly actorUserId: number;
  readonly from: "admin" | "member";
  readonly to: "admin" | "member";
}

export const effectiveRole = (membership: Membership): WorkspaceRole =>
  membership.githubOwner ? "owner" : membership.appRole;

export class MembershipRepository extends Effect.Service<MembershipRepository>()(
  "@not-quite-my-tempo/db/MembershipRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        /**
         * Makes the user's memberships match GitHub's answer: upserts each
         * listed workspace (refreshing githubOwner and verifiedAt, never
         * appRole) and deletes memberships GitHub no longer lists.
         * Idempotent for the same answer.
         */
        syncForUser: (
          userId: number,
          verified: readonly VerifiedMembership[],
          verifiedAt: Date,
        ) =>
          databaseEffect("memberships.sync_for_user", () =>
            client.batch([
              client
                .delete(memberships)
                .where(
                  and(
                    eq(memberships.userId, userId),
                    sql`${memberships.workspaceId} not in (select value from json_each(${JSON.stringify(verified.map((entry) => entry.workspaceId))}))`,
                  ),
                ),
              ...verified.map((entry) =>
                client
                  .insert(memberships)
                  .values({
                    workspaceId: entry.workspaceId,
                    userId,
                    githubOwner: entry.githubOwner,
                    verifiedAt,
                  })
                  .onConflictDoUpdate({
                    target: [memberships.workspaceId, memberships.userId],
                    set: {
                      githubOwner: entry.githubOwner,
                      verifiedAt,
                      updatedAt: verifiedAt,
                    },
                  }),
              ),
            ]),
          ).pipe(Effect.asVoid),
        /**
         * Removes one user's membership of the workspace for a GitHub
         * account, unless a refresh verified it after `before` (so a late
         * removal event can't undo a newer sign-in).
         */
        removeForAccount: (
          userId: number,
          githubAccountId: number,
          before: Date,
        ) =>
          databaseEffect("memberships.remove_for_account", () =>
            client
              .delete(memberships)
              .where(
                and(
                  eq(memberships.userId, userId),
                  lt(memberships.verifiedAt, before),
                  sql`${memberships.workspaceId} in (select ${workspaces.id} from ${workspaces} where ${workspaces.githubAccountId} = ${githubAccountId})`,
                ),
              )
              .run(),
          ).pipe(Effect.asVoid),
        removeAllForUser: (userId: number) =>
          databaseEffect("memberships.remove_all_for_user", () =>
            client
              .delete(memberships)
              .where(eq(memberships.userId, userId))
              .run(),
          ).pipe(Effect.asVoid),
        findForUser: (workspaceId: number, userId: number) =>
          databaseEffect("memberships.find_for_user", () =>
            client
              .select({ membership: memberships, workspace: workspaces })
              .from(memberships)
              .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
              .where(
                and(
                  eq(memberships.workspaceId, workspaceId),
                  eq(memberships.userId, userId),
                ),
              )
              .get(),
          ).pipe(
            Effect.map((row) =>
              Option.fromNullable(row).pipe(
                Option.map((found): WorkspaceMembership => ({
                  workspace: found.workspace,
                  role: effectiveRole(found.membership),
                  verifiedAt: found.membership.verifiedAt,
                })),
              ),
            ),
          ),
        listForWorkspace: (workspaceId: number) =>
          databaseEffect("memberships.list_for_workspace", () =>
            client
              .select({ membership: memberships, login: users.login })
              .from(memberships)
              .innerJoin(users, eq(memberships.userId, users.id))
              .where(eq(memberships.workspaceId, workspaceId))
              .orderBy(users.login)
              .all(),
          ).pipe(
            Effect.map((rows) =>
              rows.map((row): WorkspaceMember => ({
                userId: row.membership.userId,
                login: row.login,
                role: effectiveRole(row.membership),
                verifiedAt: row.membership.verifiedAt,
              })),
            ),
          ),
        /**
         * Sets the in-app role to an absolute value (so a double submit is
         * harmless) and records who changed it, in one batch.
         */
        setAppRoleWithAudit: (change: RoleChange) =>
          databaseEffect("memberships.set_app_role_with_audit", () =>
            client.batch([
              client
                .update(memberships)
                .set({ appRole: change.to, updatedAt: new Date() })
                .where(
                  and(
                    eq(memberships.workspaceId, change.workspaceId),
                    eq(memberships.userId, change.targetUserId),
                  ),
                ),
              client.insert(auditEvents).values({
                workspaceId: change.workspaceId,
                actorUserId: change.actorUserId,
                action: "role.changed",
                target: `user:${change.targetUserId}`,
                before: JSON.stringify({ role: change.from }),
                after: JSON.stringify({ role: change.to }),
              }),
            ]),
          ).pipe(Effect.asVoid),
        listForUser: (userId: number) =>
          databaseEffect("memberships.list_for_user", () =>
            client
              .select({ membership: memberships, workspace: workspaces })
              .from(memberships)
              .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
              .where(eq(memberships.userId, userId))
              .orderBy(workspaces.githubAccountLogin)
              .all(),
          ).pipe(
            Effect.map((rows) =>
              rows.map((row): WorkspaceMembership => ({
                workspace: row.workspace,
                role: effectiveRole(row.membership),
                verifiedAt: row.membership.verifiedAt,
              })),
            ),
          ),
      };
    }),
  },
) {}

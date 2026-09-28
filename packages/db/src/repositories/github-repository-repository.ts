import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { auditEvents } from "../schema/audit-events.js";
import { githubInstallations } from "../schema/github-installations.js";
import { memberships } from "../schema/memberships.js";
import { repositories } from "../schema/repositories.js";
import { Database } from "../services/database.js";
import { effectiveRole } from "./membership-repository.js";
import type { WorkspaceRole } from "./membership-repository.js";

export type GitHubRepository = typeof repositories.$inferSelect;

export type UpsertGitHubRepositoryInput = Pick<
  GitHubRepository,
  "installationId" | "githubRepositoryId" | "owner" | "name" | "defaultBranch"
>;

export type InstallationRepositoryInput = Omit<
  UpsertGitHubRepositoryInput,
  "installationId"
>;

/** A repository the user may see, with their role in its workspace. */
export interface VisibleRepository {
  readonly repository: GitHubRepository;
  readonly workspaceId: number;
  readonly role: WorkspaceRole;
}

export interface RepositoryAuditActor {
  readonly workspaceId: number;
  readonly actorUserId: number;
}

export class GitHubRepositoryRepository extends Effect.Service<GitHubRepositoryRepository>()(
  "@not-quite-my-tempo/db/GitHubRepositoryRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      const upsertStatement = (
        input: UpsertGitHubRepositoryInput,
        restore: boolean,
      ) =>
        client
          .insert(repositories)
          .values({
            ...input,
            fullName: `${input.owner}/${input.name}`,
          })
          .onConflictDoUpdate({
            target: repositories.githubRepositoryId,
            set: {
              installationId: input.installationId,
              owner: input.owner,
              name: input.name,
              fullName: `${input.owner}/${input.name}`,
              defaultBranch: input.defaultBranch,
              removedAt: restore ? null : sql`${repositories.removedAt}`,
              updatedAt: new Date(),
            },
          })
          .returning();

      return {
        upsert: (input: UpsertGitHubRepositoryInput) =>
          databaseEffect("repositories.upsert", () =>
            upsertStatement(input, false).get(),
          ),
        /**
         * Reconciles an installation's repositories with the full list GitHub
         * reports: listed repositories are upserted and restored, the rest
         * of the installation's repositories are marked removed.
         */
        syncForInstallation: (
          installationId: number,
          inputs: readonly InstallationRepositoryInput[],
        ) =>
          databaseEffect("repositories.sync_for_installation", () => {
            const now = new Date();

            return client.batch([
              client
                .update(repositories)
                .set({ removedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(repositories.installationId, installationId),
                    isNull(repositories.removedAt),
                    sql`${repositories.githubRepositoryId} not in (select value from json_each(${JSON.stringify(inputs.map((input) => input.githubRepositoryId))}))`,
                  ),
                ),
              ...inputs.map((input) =>
                upsertStatement({ ...input, installationId }, true),
              ),
            ]);
          }).pipe(Effect.asVoid),
        removeAllForInstallation: (installationId: number) =>
          databaseEffect("repositories.remove_all_for_installation", () => {
            const now = new Date();

            return client
              .update(repositories)
              .set({ removedAt: now, updatedAt: now })
              .where(
                and(
                  eq(repositories.installationId, installationId),
                  isNull(repositories.removedAt),
                ),
              )
              .run();
          }).pipe(Effect.asVoid),
        listByGithubRepositoryIds: (githubRepositoryIds: readonly number[]) =>
          githubRepositoryIds.length === 0
            ? Effect.succeed<readonly GitHubRepository[]>([])
            : databaseEffect("repositories.list_by_github_repository_ids", () =>
                client
                  .select()
                  .from(repositories)
                  .where(
                    and(
                      isNull(repositories.removedAt),
                      sql`${repositories.githubRepositoryId} in (select value from json_each(${JSON.stringify(githubRepositoryIds)}))`,
                    ),
                  )
                  .all(),
              ),
        /**
         * Repositories the user can see: not removed, visible to them on
         * GitHub (githubRepositoryIds from their session), and in a
         * workspace they belong to. Both conditions live in one query so a
         * missed check elsewhere cannot cross workspaces.
         */
        listVisibleToUser: (
          userId: number,
          githubRepositoryIds: readonly number[],
          id?: number,
        ) =>
          githubRepositoryIds.length === 0
            ? Effect.succeed<readonly VisibleRepository[]>([])
            : databaseEffect("repositories.list_visible_to_user", () =>
                client
                  .select({
                    repository: repositories,
                    membership: memberships,
                  })
                  .from(repositories)
                  .innerJoin(
                    githubInstallations,
                    eq(repositories.installationId, githubInstallations.id),
                  )
                  .innerJoin(
                    memberships,
                    and(
                      eq(
                        memberships.workspaceId,
                        githubInstallations.workspaceId,
                      ),
                      eq(memberships.userId, userId),
                    ),
                  )
                  .where(
                    and(
                      isNull(repositories.removedAt),
                      id === undefined ? undefined : eq(repositories.id, id),
                      sql`${repositories.githubRepositoryId} in (select value from json_each(${JSON.stringify(githubRepositoryIds)}))`,
                    ),
                  )
                  .orderBy(repositories.fullName)
                  .all(),
              ).pipe(
                Effect.map((rows) =>
                  rows.map((row): VisibleRepository => ({
                    repository: row.repository,
                    workspaceId: row.membership.workspaceId,
                    role: effectiveRole(row.membership),
                  })),
                ),
              ),
        /** Sets review on/off and records who did it, in one batch. */
        setEnabledWithAudit: (
          repository: GitHubRepository,
          enabled: boolean,
          actor: RepositoryAuditActor,
        ) =>
          databaseEffect("repositories.set_enabled_with_audit", () =>
            client.batch([
              client
                .update(repositories)
                .set({ enabled, updatedAt: new Date() })
                .where(eq(repositories.id, repository.id)),
              client.insert(auditEvents).values({
                workspaceId: actor.workspaceId,
                actorUserId: actor.actorUserId,
                action: "repository.reviews_toggled",
                target: `repository:${repository.id}`,
                before: JSON.stringify({ enabled: repository.enabled }),
                after: JSON.stringify({ enabled }),
              }),
            ]),
          ).pipe(Effect.asVoid),
        setEnabled: (id: number, enabled: boolean) =>
          databaseEffect("repositories.set_enabled", () =>
            client
              .update(repositories)
              .set({ enabled, updatedAt: new Date() })
              .where(eq(repositories.id, id))
              .run(),
          ).pipe(Effect.asVoid),
        findById: (id: number) =>
          databaseEffect("repositories.find_by_id", () =>
            client
              .select()
              .from(repositories)
              .where(eq(repositories.id, id))
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { auditEvents } from "../schema/audit-events.js";
import { findings } from "../schema/findings.js";
import { githubInstallations } from "../schema/github-installations.js";
import { memberships } from "../schema/memberships.js";
import { repositories } from "../schema/repositories.js";
import { reviewRunRetries } from "../schema/review-run-retries.js";
import { reviewRuns } from "../schema/review-runs.js";
import { reviewKeyProviders, workspaces } from "../schema/workspaces.js";
import { Database } from "../services/database.js";
import type { Workspace } from "./membership-repository.js";

export interface ReviewKeyChange {
  readonly workspaceId: number;
  readonly actorUserId: number;
  readonly previousLast4: string | null;
}

export interface SavedReviewKey extends ReviewKeyChange {
  readonly ciphertext: string;
  readonly last4: string;
  readonly provider: ReviewKeyProvider;
  /** The own-key model to keep; null resets it to the provider default. */
  readonly model: string | null;
}

/** An admin's model choice, for own-key reviews or for the paid plan. */
export interface ModelChoice {
  readonly workspaceId: number;
  readonly actorUserId: number;
  readonly previousModel: string | null;
  readonly model: string | null;
}

export type ReviewKeyProvider = (typeof reviewKeyProviders)[number];

/** Polar statuses that mean the workspace is paying. */
export const paidSubscriptionStatuses = ["active", "trialing"] as const;

/**
 * A workspace's plan as Fletcher read it from Polar's API. All the
 * subscription fields are null when Polar has no subscription for it.
 */
export interface SubscriptionState {
  readonly workspaceId: number;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly status: string | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  /** When the read from Polar started. */
  readonly syncedAt: Date;
}

export class WorkspaceRepository extends Effect.Service<WorkspaceRepository>()(
  "@not-quite-my-tempo/db/WorkspaceRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        findById: (id: number) =>
          databaseEffect("workspaces.find_by_id", () =>
            client.select().from(workspaces).where(eq(workspaces.id, id)).get(),
          ).pipe(Effect.map(Option.fromNullable<Workspace | undefined>)),
        /** The workspace a repository's installation belongs to. */
        findByRepositoryId: (repositoryId: number) =>
          databaseEffect("workspaces.find_by_repository_id", () =>
            client
              .select({ workspace: workspaces })
              .from(repositories)
              .innerJoin(
                githubInstallations,
                eq(repositories.installationId, githubInstallations.id),
              )
              .innerJoin(
                workspaces,
                eq(githubInstallations.workspaceId, workspaces.id),
              )
              .where(eq(repositories.id, repositoryId))
              .get(),
          ).pipe(
            Effect.map((row) =>
              Option.fromNullable(row).pipe(
                Option.map((found) => found.workspace),
              ),
            ),
          ),
        /** Stores an encrypted key and records who saved it, in one batch. */
        saveReviewKeyWithAudit: (saved: SavedReviewKey) =>
          databaseEffect("workspaces.save_review_key", () => {
            const now = new Date();

            return client.batch([
              client
                .update(workspaces)
                .set({
                  geminiKeyCiphertext: saved.ciphertext,
                  geminiKeyLast4: saved.last4,
                  geminiKeyProvider: saved.provider,
                  geminiKeyUpdatedAt: now,
                  geminiKeyUpdatedBy: saved.actorUserId,
                  reviewModel: saved.model,
                  updatedAt: now,
                })
                .where(eq(workspaces.id, saved.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: saved.workspaceId,
                actorUserId: saved.actorUserId,
                action: "review_key.saved",
                target: `workspace:${saved.workspaceId}`,
                before: JSON.stringify({ last4: saved.previousLast4 }),
                after: JSON.stringify({
                  last4: saved.last4,
                  provider: saved.provider,
                }),
              }),
            ]);
          }).pipe(Effect.asVoid),
        /**
         * Stores the plan read from Polar and audits a status change.
         * Returns false when a read that started later was already stored,
         * so concurrent syncs can't go backwards.
         */
        applySubscription: (
          state: SubscriptionState,
          previousStatus: string | null,
        ) =>
          Effect.gen(function* () {
            const updated = yield* databaseEffect(
              "workspaces.apply_subscription",
              () =>
                client
                  .update(workspaces)
                  .set({
                    polarCustomerId: state.customerId,
                    polarSubscriptionId: state.subscriptionId,
                    subscriptionStatus: state.status,
                    subscriptionPeriodStart: state.periodStart,
                    subscriptionPeriodEnd: state.periodEnd,
                    subscriptionCancelAtPeriodEnd: state.cancelAtPeriodEnd,
                    subscriptionSyncedAt: state.syncedAt,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(workspaces.id, state.workspaceId),
                      or(
                        isNull(workspaces.subscriptionSyncedAt),
                        lte(workspaces.subscriptionSyncedAt, state.syncedAt),
                      ),
                    ),
                  )
                  .returning({ id: workspaces.id })
                  .all(),
            );

            const applied = updated.length > 0;

            if (applied && state.status !== previousStatus) {
              yield* databaseEffect("workspaces.audit_plan_change", () =>
                client
                  .insert(auditEvents)
                  .values({
                    workspaceId: state.workspaceId,
                    actorUserId: null,
                    action: "billing.plan_changed",
                    target: `workspace:${state.workspaceId}`,
                    before: JSON.stringify({ status: previousStatus }),
                    after: JSON.stringify({
                      status: state.status,
                      subscriptionId: state.subscriptionId,
                    }),
                  })
                  .run(),
              );
            }

            return applied;
          }),
        /**
         * Deletes everything stored for the workspace's GitHub account
         * (installations, repositories, reviews, findings, members, audit
         * history, and the API key) in one batch, leaving the workspace
         * row as a record of the account, its billing references, and its
         * used free reviews (docs/ACCOUNT_DELETION.md). Free reviews used by
         * the deleted runs are carried onto the workspaces they were
         * charged to, so a repository transferred in can't refund another
         * workspace's trial either. Paid-plan credits the workspace's own
         * deleted runs used in their latest period are carried the same
         * way. One audit row records the deletion.
         */
        deleteDataWithAudit: (workspaceId: number, actorUserId: number) =>
          databaseEffect("workspaces.delete_data", () => {
            const workspaceRepositories = client
              .select({ id: repositories.id })
              .from(repositories)
              .innerJoin(
                githubInstallations,
                eq(repositories.installationId, githubInstallations.id),
              )
              .where(eq(githubInstallations.workspaceId, workspaceId));

            const workspaceRuns = client
              .select({ id: reviewRuns.id })
              .from(reviewRuns)
              .where(inArray(reviewRuns.repositoryId, workspaceRepositories));

            const deletedTrialReviews = and(
              eq(reviewRuns.trialWorkspaceId, workspaces.id),
              eq(reviewRuns.keySource, "platform"),
              inArray(reviewRuns.status, ["queued", "running", "completed"]),
              inArray(reviewRuns.repositoryId, workspaceRepositories),
            );

            // The workspace's own deleted runs that used paid-plan credits,
            // and the latest billing period among them.
            const chargedRuns = sql`from review_runs as charged
              where charged.credits_workspace_id = ${workspaceId}
                and charged.key_source = 'subscription'
                and charged.status in ('queued', 'running', 'completed')
                and charged.repository_id in (${workspaceRepositories})`;

            const latestPeriod = sql`(select max(charged.credits_period_start) ${chargedRuns})`;

            const now = new Date();

            return client.batch([
              client
                .update(workspaces)
                .set({
                  creditsCarriedX100: sql`(case
                      when ${workspaces.creditsCarriedPeriodStart} = ${latestPeriod}
                      then ${workspaces.creditsCarriedX100} else 0 end)
                    + (select coalesce(sum(charged.credits_x100), 0) ${chargedRuns}
                      and charged.credits_period_start = ${latestPeriod})`,
                  creditsCarriedPeriodStart: sql`${latestPeriod}`,
                })
                .where(
                  and(
                    eq(workspaces.id, workspaceId),
                    sql`${latestPeriod} is not null`,
                  ),
                ),
              client
                .delete(auditEvents)
                .where(eq(auditEvents.workspaceId, workspaceId)),
              client.insert(auditEvents).values({
                workspaceId,
                actorUserId,
                action: "workspace.data_deleted",
                target: `workspace:${workspaceId}`,
                after: sql`json_object(
                  'repositories', (select count(*) from (${workspaceRepositories})),
                  'reviews', (select count(*) from (${workspaceRuns}))
                )`,
              }),
              client
                .update(workspaces)
                .set({
                  trialReviewsCarried: sql`${workspaces.trialReviewsCarried} + (select count(*) from ${reviewRuns} where ${deletedTrialReviews})`,
                })
                .where(
                  inArray(
                    workspaces.id,
                    client
                      .select({ id: reviewRuns.trialWorkspaceId })
                      .from(reviewRuns)
                      .where(
                        inArray(reviewRuns.repositoryId, workspaceRepositories),
                      ),
                  ),
                ),
              client
                .delete(findings)
                .where(inArray(findings.reviewRunId, workspaceRuns)),
              client
                .delete(reviewRunRetries)
                .where(inArray(reviewRunRetries.reviewRunId, workspaceRuns)),
              client
                .delete(reviewRuns)
                .where(inArray(reviewRuns.repositoryId, workspaceRepositories)),
              client
                .delete(repositories)
                .where(
                  inArray(
                    repositories.installationId,
                    client
                      .select({ id: githubInstallations.id })
                      .from(githubInstallations)
                      .where(eq(githubInstallations.workspaceId, workspaceId)),
                  ),
                ),
              client
                .delete(githubInstallations)
                .where(eq(githubInstallations.workspaceId, workspaceId)),
              client
                .delete(memberships)
                .where(eq(memberships.workspaceId, workspaceId)),
              client
                .update(workspaces)
                .set({
                  geminiKeyCiphertext: null,
                  geminiKeyLast4: null,
                  geminiKeyProvider: null,
                  geminiKeyUpdatedAt: null,
                  geminiKeyUpdatedBy: null,
                  dataDeletedAt: now,
                  updatedAt: now,
                })
                .where(eq(workspaces.id, workspaceId)),
            ]);
          }).pipe(Effect.asVoid),
        removeReviewKeyWithAudit: (change: ReviewKeyChange) =>
          databaseEffect("workspaces.remove_review_key", () => {
            const now = new Date();

            return client.batch([
              client
                .update(workspaces)
                .set({
                  geminiKeyCiphertext: null,
                  geminiKeyLast4: null,
                  geminiKeyProvider: null,
                  geminiKeyUpdatedAt: now,
                  geminiKeyUpdatedBy: change.actorUserId,
                  reviewModel: null,
                  updatedAt: now,
                })
                .where(eq(workspaces.id, change.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: change.workspaceId,
                actorUserId: change.actorUserId,
                action: "review_key.removed",
                target: `workspace:${change.workspaceId}`,
                before: JSON.stringify({ last4: change.previousLast4 }),
                after: JSON.stringify({ last4: null }),
              }),
            ]);
          }).pipe(Effect.asVoid),
        /** Sets the model own-key reviews use, and audits the change. */
        saveReviewModelWithAudit: (choice: ModelChoice) =>
          databaseEffect("workspaces.save_review_model", () =>
            client.batch([
              client
                .update(workspaces)
                .set({ reviewModel: choice.model, updatedAt: new Date() })
                .where(eq(workspaces.id, choice.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: choice.workspaceId,
                actorUserId: choice.actorUserId,
                action: "review_model.changed",
                target: `workspace:${choice.workspaceId}`,
                before: JSON.stringify({ model: choice.previousModel }),
                after: JSON.stringify({ model: choice.model }),
              }),
            ]),
          ).pipe(Effect.asVoid),
        /** Sets the paid plan's model, and audits the change. */
        savePlanModelWithAudit: (choice: ModelChoice) =>
          databaseEffect("workspaces.save_plan_model", () =>
            client.batch([
              client
                .update(workspaces)
                .set({ planModel: choice.model, updatedAt: new Date() })
                .where(eq(workspaces.id, choice.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: choice.workspaceId,
                actorUserId: choice.actorUserId,
                action: "plan_model.changed",
                target: `workspace:${choice.workspaceId}`,
                before: JSON.stringify({ model: choice.previousModel }),
                after: JSON.stringify({ model: choice.model }),
              }),
            ]),
          ).pipe(Effect.asVoid),
      };
    }),
  },
) {}

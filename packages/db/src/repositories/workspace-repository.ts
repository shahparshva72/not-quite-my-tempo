import { and, eq, gt, lt, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { auditEvents } from "../schema/audit-events.js";
import { githubInstallations } from "../schema/github-installations.js";
import { repositories } from "../schema/repositories.js";
import { workspaces } from "../schema/workspaces.js";
import { Database } from "../services/database.js";
import type { Workspace } from "./membership-repository.js";

export interface GeminiKeyChange {
  readonly workspaceId: number;
  readonly actorUserId: number;
  readonly previousLast4: string | null;
}

export interface SavedGeminiKey extends GeminiKeyChange {
  readonly ciphertext: string;
  readonly last4: string;
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
        /**
         * Takes one free trial review if any remain. A single conditional
         * update, so concurrent reviews can't take more than `limit`.
         * Returns how many are used after taking one, or None when the
         * trial is spent.
         */
        takeTrialReview: (workspaceId: number, limit: number) =>
          databaseEffect("workspaces.take_trial_review", () =>
            client
              .update(workspaces)
              .set({
                trialReviewsUsed: sql`${workspaces.trialReviewsUsed} + 1`,
              })
              .where(
                and(
                  eq(workspaces.id, workspaceId),
                  lt(workspaces.trialReviewsUsed, limit),
                ),
              )
              .returning({ used: workspaces.trialReviewsUsed })
              .get(),
          ).pipe(
            Effect.map((row) =>
              Option.fromNullable(row).pipe(Option.map((found) => found.used)),
            ),
          ),
        /** Gives one trial review back; never goes below zero. */
        refundTrialReview: (workspaceId: number) =>
          databaseEffect("workspaces.refund_trial_review", () =>
            client
              .update(workspaces)
              .set({
                trialReviewsUsed: sql`${workspaces.trialReviewsUsed} - 1`,
              })
              .where(
                and(
                  eq(workspaces.id, workspaceId),
                  gt(workspaces.trialReviewsUsed, 0),
                ),
              )
              .run(),
          ).pipe(Effect.asVoid),
        /** Stores an encrypted key and records who saved it, in one batch. */
        saveGeminiKeyWithAudit: (saved: SavedGeminiKey) =>
          databaseEffect("workspaces.save_gemini_key", () => {
            const now = new Date();

            return client.batch([
              client
                .update(workspaces)
                .set({
                  geminiKeyCiphertext: saved.ciphertext,
                  geminiKeyLast4: saved.last4,
                  geminiKeyUpdatedAt: now,
                  geminiKeyUpdatedBy: saved.actorUserId,
                  updatedAt: now,
                })
                .where(eq(workspaces.id, saved.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: saved.workspaceId,
                actorUserId: saved.actorUserId,
                action: "gemini_key.saved",
                target: `workspace:${saved.workspaceId}`,
                before: JSON.stringify({ last4: saved.previousLast4 }),
                after: JSON.stringify({ last4: saved.last4 }),
              }),
            ]);
          }).pipe(Effect.asVoid),
        removeGeminiKeyWithAudit: (change: GeminiKeyChange) =>
          databaseEffect("workspaces.remove_gemini_key", () => {
            const now = new Date();

            return client.batch([
              client
                .update(workspaces)
                .set({
                  geminiKeyCiphertext: null,
                  geminiKeyLast4: null,
                  geminiKeyUpdatedAt: now,
                  geminiKeyUpdatedBy: change.actorUserId,
                  updatedAt: now,
                })
                .where(eq(workspaces.id, change.workspaceId)),
              client.insert(auditEvents).values({
                workspaceId: change.workspaceId,
                actorUserId: change.actorUserId,
                action: "gemini_key.removed",
                target: `workspace:${change.workspaceId}`,
                before: JSON.stringify({ last4: change.previousLast4 }),
                after: JSON.stringify({ last4: null }),
              }),
            ]);
          }).pipe(Effect.asVoid),
      };
    }),
  },
) {}

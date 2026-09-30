import { Data, Effect, Match, Option } from "effect";
import {
  paidSubscriptionStatuses,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";
import type { Workspace } from "@not-quite-my-tempo/db";

import { PolarClient } from "../billing/polar-client.js";
import type { PolarSubscription } from "../billing/polar-client.js";
import type { PolarWebhookEvent } from "../billing/polar-webhook.js";
import { logError, logInfo } from "../logging.js";
import { authorizeWorkspace } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";

/**
 * How long a paid plan outlives its period end without a renewal. Covers
 * a late or lost renewal webhook without paying for reviews forever.
 */
const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Subscriptions that still bill, or will again once a payment goes
 * through. A workspace with one must manage it, not start another.
 */
const openSubscriptionStatuses = [
  ...paidSubscriptionStatuses,
  "past_due",
  "unpaid",
] as const;

export class AlreadySubscribedError extends Data.TaggedError(
  "AlreadySubscribedError",
) {}

export class NoBillingAccountError extends Data.TaggedError(
  "NoBillingAccountError",
) {}

const statusIn = (
  statuses: readonly string[],
  status: string | null,
): boolean => status !== null && statuses.includes(status);

/**
 * Whether reviews may use the platform key without the trial. Only Polar's
 * active and trialing statuses count, and only until shortly after the
 * period the workspace paid for; a plan with no period end never counts.
 * Past-due and canceled plans fall back to the workspace key or trial
 * (docs/BILLING.md).
 */
export const hasPaidPlan = (workspace: Workspace, now: Date) =>
  statusIn(paidSubscriptionStatuses, workspace.subscriptionStatus) &&
  workspace.subscriptionPeriodEnd !== null &&
  workspace.subscriptionPeriodEnd.getTime() + RENEWAL_GRACE_MS > now.getTime();

/** Whether the workspace has a subscription to manage rather than buy. */
export const hasOpenSubscription = (workspace: Workspace) =>
  workspace.polarCustomerId !== null &&
  statusIn(openSubscriptionStatuses, workspace.subscriptionStatus);

/**
 * The subscription that decides the plan: a paid one first, then one that
 * can still recover, then the newest (Polar lists newest first).
 */
const decidingSubscription = (subscriptions: readonly PolarSubscription[]) =>
  Option.fromNullable(
    subscriptions.find((subscription) =>
      statusIn(paidSubscriptionStatuses, subscription.status),
    ),
  ).pipe(
    Option.orElse(() =>
      Option.fromNullable(
        subscriptions.find((subscription) =>
          statusIn(openSubscriptionStatuses, subscription.status),
        ),
      ),
    ),
    Option.orElse(() => Option.fromNullable(subscriptions[0])),
  );

/**
 * Stores what Polar reports for the workspace. Two paid subscriptions mean
 * someone paid twice (two checkouts finished at once); that's logged as an
 * error for a refund, and the plan uses the newer one.
 */
const recordPlan = (
  workspace: Workspace,
  subscriptions: readonly PolarSubscription[],
  syncedAt: Date,
) =>
  Effect.gen(function* () {
    const paidCount = subscriptions.filter((subscription) =>
      statusIn(paidSubscriptionStatuses, subscription.status),
    ).length;

    if (paidCount > 1) {
      yield* logError("billing_duplicate_subscriptions", {
        workspaceId: workspace.id,
        paidCount,
      });
    }

    const deciding = Option.getOrNull(decidingSubscription(subscriptions));

    const applied = yield* WorkspaceRepository.applySubscription(
      {
        workspaceId: workspace.id,
        customerId: deciding?.customer_id ?? workspace.polarCustomerId,
        subscriptionId: deciding?.id ?? null,
        status: deciding?.status ?? null,
        periodEnd: deciding?.current_period_end ?? null,
        cancelAtPeriodEnd: deciding?.cancel_at_period_end ?? false,
        syncedAt,
      },
      workspace.subscriptionStatus,
    );

    yield* logInfo(
      applied ? "billing_plan_synced" : "billing_sync_superseded",
      { workspaceId: workspace.id, status: deciding?.status ?? "none" },
    );
  });

/** Re-reads the workspace's subscriptions from Polar and stores them. */
export const syncWorkspacePlan = (workspaceId: number) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceRepository.findById(workspaceId);

    if (Option.isNone(workspace)) {
      yield* logInfo("billing_event_ignored", {
        reason: "unknown_workspace",
        workspaceId,
      });

      return false;
    }

    // Taken before the read, so a slower, older read can't overwrite it.
    const syncedAt = new Date();
    const polar = yield* PolarClient;
    const subscriptions = yield* polar.listSubscriptions(workspaceId);

    yield* recordPlan(workspace.value, subscriptions, syncedAt);

    return true;
  });

/** Acts on a verified Polar delivery; true when a workspace was synced. */
export const handlePolarWebhook = (event: PolarWebhookEvent) =>
  Match.valueTags(event, {
    SyncWorkspace: ({ workspaceId, eventType, subscriptionId }) =>
      logInfo("billing_event_received", {
        workspaceId,
        eventType,
        subscriptionId,
      }).pipe(Effect.zipRight(syncWorkspacePlan(workspaceId))),
    Ignore: () => Effect.succeed(false),
    Malformed: ({ eventType }) =>
      logError("billing_event_malformed", { eventType }).pipe(Effect.as(false)),
  });

const settingsUrl = (origin: string, workspaceId: number, notice?: string) =>
  `${origin}/workspaces/${workspaceId}/settings${
    notice === undefined ? "" : `?notice=${notice}`
  }`;

/**
 * A Polar checkout link for the workspace's paid plan. Polar is asked
 * first, never the stored plan: a payment finished moments ago may not have
 * reached Fletcher's webhook yet, and a cancellation may have been missed.
 * An open subscription is recorded and refuses a second checkout.
 */
export const startCheckout = (
  access: SessionAccess,
  workspaceId: number,
  origin: string,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_billing",
    );

    const syncedAt = new Date();
    const polar = yield* PolarClient;
    const existing = yield* polar.listSubscriptions(workspaceId);

    // Stored either way, so a cancellation whose webhook never arrived is
    // corrected here instead of blocking a new checkout.
    yield* recordPlan(viewer.workspace, existing, syncedAt);

    if (
      existing.some((subscription) =>
        statusIn(openSubscriptionStatuses, subscription.status),
      )
    ) {
      return yield* new AlreadySubscribedError();
    }

    const url = yield* polar.createCheckout({
      workspaceId,
      successUrl: settingsUrl(origin, workspaceId, "subscribed"),
    });

    yield* logInfo("billing_checkout_started", {
      workspaceId,
      actorUserId: access.userId,
    });

    return url;
  });

/** A Polar customer portal link for changing or cancelling the plan. */
export const openBillingPortal = (
  access: SessionAccess,
  workspaceId: number,
  origin: string,
) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "manage_billing",
    );

    if (viewer.workspace.polarCustomerId === null) {
      return yield* new NoBillingAccountError();
    }

    const polar = yield* PolarClient;

    // Keyed by workspace, not the stored customer ID: a customer ID Polar
    // reports can be shared with another workspace.
    return yield* polar.createPortalSession({
      workspaceId,
      returnUrl: settingsUrl(origin, workspaceId),
    });
  });

type BillingLinkEffect =
  | ReturnType<typeof startCheckout>
  | ReturnType<typeof openBillingPortal>;

/** startCheckout or openBillingPortal, for routes that handle either. */
export type BillingLink = (
  access: SessionAccess,
  workspaceId: number,
  origin: string,
) => Effect.Effect<
  string,
  Effect.Effect.Error<BillingLinkEffect>,
  Effect.Effect.Context<BillingLinkEffect>
>;

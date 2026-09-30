# Billing (Polar)

The paid plan lets a workspace review on Fletcher's Gemini key without the
5-review trial limit. Polar (polar.sh) is the merchant of record: it
handles checkout, taxes, invoices, and the customer portal, and pays out
through Stripe Connect Express (India is supported). Billing is optional.
Without Polar configured, workspaces use bring-your-own-key and the trial
([BYOK_TRIAL_DESIGN.md](./BYOK_TRIAL_DESIGN.md)).

## Which key a review uses

`chooseReviewKey` (`apps/api/src/application/review-keys.ts`), in order:

1. The workspace's own key (`key_source = 'workspace'`).
2. The platform key on a paid plan (`key_source = 'subscription'`). These
   runs never count against the trial.
3. One free trial review on the platform key (`key_source = 'platform'`).
4. None: the run is blocked and the pull request gets an "add a key or
   subscribe" comment.

A plan is paid when Polar's status is `active` or `trialing`, until 3 days
after `current_period_end` (`hasPaidPlan` in
`apps/api/src/application/billing.ts`); a plan with no period end never
counts. The grace period covers a late renewal webhook without paying for
reviews forever if one is lost. `past_due`, `canceled`, `unpaid`, and
anything else fall back to rules 1 and 3. Cancelling at period end keeps
the status `active` until the period ends, so the plan runs out on its own.

## Flow

- **Polar is the source of truth.** Fletcher never builds the plan from a
  webhook payload. `syncWorkspacePlan` lists the workspace's subscriptions
  (`GET /v1/subscriptions/?product_id=…&metadata[workspace_id]=…`, checked
  again locally), picks the deciding one (paid, then past due or unpaid,
  then newest), and stores it with the time the read started. A slower,
  older read never overwrites a newer one, so out-of-order and duplicate
  deliveries can't roll a plan back. Subscriptions to other products don't
  count, so switching products in the portal ends the plan.
- **Subscribe**: an admin or owner clicks Subscribe on
  `/workspaces/:id/settings`. `POST /workspaces/:id/billing/checkout` first
  asks Polar for the workspace's subscriptions: a payment that finished
  before its webhook arrived is recorded and a second checkout is refused.
  Otherwise it creates a checkout for `POLAR_PRODUCT_ID` with
  `metadata.workspace_id` (Polar copies it onto the subscription) and
  `external_customer_id = workspace-<id>`, and redirects there. The
  external ID keeps each workspace its own Polar customer: without it Polar
  matches customers by billing email, so two workspaces paid with the same
  email would share a customer and their admins the same portal. Two checkouts paid at the same moment can still both
  succeed; the sync logs `billing_duplicate_subscriptions` so the extra
  one can be refunded.
- **Webhook**: `POST /webhooks/polar` verifies the Standard Webhooks
  signature (`webhook-id`, `webhook-timestamp` within 5 minutes,
  `webhook-signature`). A `subscription.*` event with a `workspace_id` in
  its metadata triggers a sync of that workspace. Other events and
  subscriptions Fletcher didn't create are acknowledged (202). A
  subscription event in an unexpected shape is acknowledged and logged as
  `billing_event_malformed`. When Polar can't be read, the webhook returns
  500 so Polar retries it.
- **Manage**: a workspace with an active, trialing, past-due, or unpaid
  subscription gets Manage billing instead of Subscribe, and checkout is
  refused. `POST /workspaces/:id/billing/portal` opens a Polar customer
  session for `external_customer_id = workspace-<id>`, never for the stored
  `polar_customer_id`.
- **Audit**: every plan status change is recorded in `audit_events` as
  `billing.plan_changed`.

Only admins and owners (`manage_billing`) can subscribe or open the portal;
members see the plan status. Billing is on only when `POLAR_ACCESS_TOKEN`,
`POLAR_PRODUCT_ID`, and `POLAR_WEBHOOK_SECRET` are all set; without the
webhook nobody would ever be marked paid. Pull requests blocked for lack
of a key only suggest subscribing when billing is on.

## Setup

1. Create an organization on polar.sh (or sandbox.polar.sh to test) and
   complete payout onboarding.
2. Create a recurring product for the paid plan and copy its ID into
   `POLAR_PRODUCT_ID`.
3. Create an organization access token with `checkouts:write`,
   `customer_sessions:write`, and `subscriptions:read`, and store it as
   `POLAR_ACCESS_TOKEN`.
4. Add a webhook endpoint at `https://<origin>/webhooks/polar`, format Raw,
   with the `subscription.created`, `subscription.updated`,
   `subscription.active`, `subscription.canceled`,
   `subscription.uncanceled`, `subscription.past_due`, and
   `subscription.revoked` events. Store its `whsec_…` secret as
   `POLAR_WEBHOOK_SECRET`.
5. Set `POLAR_SERVER=sandbox` while testing against sandbox.polar.sh.
6. Apply the `0014` migration: `pnpm db:migrate:remote`.

Webhook secrets created before 8 Sep 2026 use Polar's older signing scheme
and won't verify; create a new endpoint secret if deliveries return 401.

To test locally, expose `wrangler dev` with its tunnel (press `t`), point
a sandbox webhook at the tunnel URL, and pay with Stripe's test card
`4242 4242 4242 4242`.

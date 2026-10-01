import { Context, Data, Effect, Layer, Option, Schema } from "effect";

// Polar is the merchant of record for the paid plan (docs/BILLING.md).
const POLAR_API_BASE_URLS = {
  production: "https://api.polar.sh",
  sandbox: "https://sandbox-api.polar.sh",
} as const;

/** Polar calls fail fast so the page can say so instead of hanging. */
const POLAR_TIMEOUT_MS = 10_000;

// More subscriptions than this for one workspace would be an incident.
const SUBSCRIPTION_PAGE_SIZE = 100;

export type PolarServer = keyof typeof POLAR_API_BASE_URLS;

export class PolarRequestError extends Data.TaggedError("PolarRequestError")<{
  readonly operation: string;
  readonly status: number | null;
}> {}

const CheckoutResponse = Schema.Struct({ url: Schema.NonEmptyString });

const CustomerSessionResponse = Schema.Struct({
  customer_portal_url: Schema.NonEmptyString,
});

const Subscription = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  customer_id: Schema.NonEmptyString,
  product_id: Schema.NonEmptyString,
  current_period_end: Schema.NullOr(Schema.DateFromString),
  cancel_at_period_end: Schema.Boolean,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const SubscriptionList = Schema.Struct({ items: Schema.Array(Subscription) });

export type PolarSubscription = typeof Subscription.Type;

export interface PolarClientService {
  /** A hosted checkout for the paid plan, tagged with the workspace. */
  readonly createCheckout: (input: {
    readonly workspaceId: number;
    readonly successUrl: string;
  }) => Effect.Effect<string, PolarRequestError>;
  /** A short-lived link to the workspace's own customer portal. */
  readonly createPortalSession: (input: {
    readonly workspaceId: number;
    readonly returnUrl: string;
  }) => Effect.Effect<string, PolarRequestError>;
  /**
   * The workspace's subscriptions to the paid-plan product, newest first:
   * Polar's current state, which is what the plan is built from.
   */
  readonly listSubscriptions: (
    workspaceId: number,
  ) => Effect.Effect<readonly PolarSubscription[], PolarRequestError>;
}

export class PolarClient extends Context.Tag(
  "@not-quite-my-tempo/api/PolarClient",
)<PolarClient, PolarClientService>() {}

export interface PolarConfig {
  readonly accessToken: string;
  readonly productId: string;
  readonly webhookSecret: string;
  readonly server: PolarServer;
}

const present = (value: string | undefined) =>
  Option.fromNullable(value).pipe(Option.filter((set) => set !== ""));

/**
 * Billing is on only when the access token, product, and webhook secret
 * are all set. Without the webhook nothing would ever mark a workspace
 * paid, so people could pay for a plan they never get.
 */
export const polarConfig = (env: {
  readonly POLAR_ACCESS_TOKEN?: string | undefined;
  readonly POLAR_PRODUCT_ID?: string | undefined;
  readonly POLAR_WEBHOOK_SECRET?: string | undefined;
  readonly POLAR_SERVER?: string | undefined;
}): Option.Option<PolarConfig> =>
  Option.all({
    accessToken: present(env.POLAR_ACCESS_TOKEN),
    productId: present(env.POLAR_PRODUCT_ID),
    webhookSecret: present(env.POLAR_WEBHOOK_SECRET),
  }).pipe(
    Option.map((required) => ({
      ...required,
      server: env.POLAR_SERVER === "sandbox" ? "sandbox" : "production",
    })),
  );

interface CheckoutRequest {
  readonly products: readonly string[];
  readonly success_url: string;
  readonly external_customer_id: string;
  readonly metadata: { readonly workspace_id: string };
}

interface CustomerSessionRequest {
  readonly external_customer_id: string;
  readonly return_url: string;
}

/**
 * Ties a workspace to one Polar customer by our own ID rather than by
 * billing email. Without this, Polar matches customers by the email
 * entered at checkout: two workspaces whose admins share an email would
 * be merged into the same customer, and the portal exposes a customer's
 * full billing (invoices, payment methods, every subscription) - so one
 * workspace's admin could reach another's.
 */
const externalCustomerId = (workspaceId: number) => `workspace-${workspaceId}`;

interface PolarRequest {
  readonly operation: string;
  readonly path: string;
  readonly body?: CheckoutRequest | CustomerSessionRequest;
}

const polarRequest = <A, I>(
  config: PolarConfig,
  request: PolarRequest,
  schema: Schema.Schema<A, I>,
) =>
  Effect.gen(function* () {
    const { operation } = request;

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${POLAR_API_BASE_URLS[config.server]}${request.path}`, {
          method: request.body === undefined ? "GET" : "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body:
            request.body === undefined ? null : JSON.stringify(request.body),
          signal: AbortSignal.timeout(POLAR_TIMEOUT_MS),
        }),
      catch: () => new PolarRequestError({ operation, status: null }),
    });

    if (!response.ok) {
      return yield* new PolarRequestError({
        operation,
        status: response.status,
      });
    }

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new PolarRequestError({ operation, status: response.status }),
    });

    return yield* Schema.decodeUnknown(Schema.parseJson(schema))(text).pipe(
      Effect.mapError(
        () => new PolarRequestError({ operation, status: response.status }),
      ),
    );
  });

export const PolarClientLive = (config: PolarConfig) =>
  Layer.succeed(
    PolarClient,
    PolarClient.of({
      createCheckout: ({ workspaceId, successUrl }) =>
        polarRequest(
          config,
          {
            operation: "create_checkout",
            path: "/v1/checkouts/",
            body: {
              products: [config.productId],
              success_url: successUrl,
              external_customer_id: externalCustomerId(workspaceId),
              // Copied onto the subscription, which is how Fletcher finds
              // a workspace's subscriptions again.
              metadata: { workspace_id: String(workspaceId) },
            },
          },
          CheckoutResponse,
        ).pipe(Effect.map((checkout) => checkout.url)),
      createPortalSession: ({ workspaceId, returnUrl }) =>
        polarRequest(
          config,
          {
            operation: "create_customer_session",
            path: "/v1/customer-sessions/",
            body: {
              external_customer_id: externalCustomerId(workspaceId),
              return_url: returnUrl,
            },
          },
          CustomerSessionResponse,
        ).pipe(Effect.map((session) => session.customer_portal_url)),
      listSubscriptions: (workspaceId) => {
        const query = new URLSearchParams({
          product_id: config.productId,
          "metadata[workspace_id]": String(workspaceId),
          limit: String(SUBSCRIPTION_PAGE_SIZE),
          sorting: "-started_at",
        });

        return polarRequest(
          config,
          {
            operation: "list_subscriptions",
            path: `/v1/subscriptions/?${query.toString()}`,
          },
          SubscriptionList,
        ).pipe(
          // Polar filters these already; checked again so a subscription
          // moved to another product, or another workspace's, never
          // counts as this workspace's paid plan.
          Effect.map((list) =>
            list.items.filter(
              (subscription) =>
                subscription.product_id === config.productId &&
                subscription.metadata["workspace_id"] === String(workspaceId),
            ),
          ),
        );
      },
    }),
  );

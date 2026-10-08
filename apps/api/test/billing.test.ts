import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeLiveLayer,
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";

import app from "../src/index";
import { chooseReviewKey } from "../src/application/review-keys";
import { forgetPlanPrices } from "../src/billing/plan-price";
import {
  sessionCookie,
  TEST_SESSION_SECRET,
  TEST_TOKEN_ENCRYPTION_KEY,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const WEBHOOK_SECRET = `whsec_${btoa("polar-test-webhook-secret-bytes")}`;

const PRODUCT_ID = "prod-hosted";

const billingEnv = {
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,
  POLAR_ACCESS_TOKEN: "polar_oat_test",
  POLAR_PRODUCT_ID: PRODUCT_ID,
  POLAR_SERVER: "sandbox",
  POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

// Set explicitly: apps/api/.dev.vars may define real POLAR_* values.
const withoutWebhookSecret = { ...billingEnv, POLAR_WEBHOOK_SECRET: "" };

const request = (
  path: string,
  init?: RequestInit,
  testEnv: typeof billingEnv = billingEnv,
) => app.request(`https://example.com${path}`, init, testEnv);

const post = (path: string, cookie: string, testEnv?: typeof billingEnv) =>
  request(
    path,
    {
      method: "POST",
      headers: { cookie, origin: "https://example.com" },
    },
    testEnv,
  );

const sign = async (id: string, timestamp: number, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(WEBHOOK_SECRET.slice("whsec_".length)), (char) =>
      char.charCodeAt(0),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );

  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
};

const subscriptionEvent = (
  type: string,
  metadata: Readonly<Record<string, string>>,
) =>
  JSON.stringify({
    type,
    timestamp: "2026-09-30T10:00:00Z",
    data: { id: "sub_1", status: "active", metadata },
  });

const deliver = async (
  body: string,
  { signatureFor = body, sentAt = Date.now() / 1000 } = {},
) => {
  const timestamp = Math.floor(sentAt);

  return request("/webhooks/polar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": await sign("msg_1", timestamp, signatureFor),
    },
    body,
  });
};

const DAY_MS = 86_400_000;

interface SubscriptionFixture {
  readonly id: string;
  readonly status: string;
  readonly customer_id: string;
  readonly product_id: string;
  readonly current_period_start: string;
  readonly current_period_end: string;
  readonly cancel_at_period_end: boolean;
  readonly started_at: string;
  readonly metadata: { readonly workspace_id: string };
}

const polarSubscription = (
  id: string,
  status: string,
  { productId = PRODUCT_ID, workspaceId = "1" } = {},
): SubscriptionFixture => ({
  id,
  status,
  customer_id: "cus_1",
  product_id: productId,
  current_period_start: new Date(Date.now() - DAY_MS).toISOString(),
  current_period_end: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  cancel_at_period_end: false,
  started_at: "2026-09-30T09:00:00Z",
  metadata: { workspace_id: workspaceId },
});

const polarProduct = {
  id: PRODUCT_ID,
  name: "Fletcher Pro",
  recurring_interval: "month",
  prices: [
    {
      amount_type: "fixed",
      price_amount: 500,
      price_currency: "usd",
      is_archived: true,
    },
    {
      amount_type: "fixed",
      price_amount: 1000,
      price_currency: "usd",
      is_archived: false,
    },
  ],
};

let productReads = 0;

interface PolarCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/**
 * Answers Polar's API like the sandbox: `subscriptions` is what the list
 * endpoint returns. Records every billing call; product reads only decorate
 * pages (and are cached), so they're counted apart in `productReads`.
 */
const polarAnswers = (
  subscriptions: readonly SubscriptionFixture[] = [],
  status = 200,
): PolarCall[] => {
  const calls: PolarCall[] = [];
  productReads = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);

    if (url.includes("/v1/products/")) {
      productReads += 1;

      return Promise.resolve(
        new Response(JSON.stringify(polarProduct), { status }),
      );
    }

    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    const answer = url.includes("/v1/subscriptions/")
      ? { items: subscriptions, pagination: { total_count: 0, max_page: 1 } }
      : {
          url: "https://sandbox.polar.sh/checkout/abc",
          customer_portal_url: "https://sandbox.polar.sh/portal/xyz",
        };

    return Promise.resolve(new Response(JSON.stringify(answer), { status }));
  });

  return calls;
};

const plan = () =>
  env.DB.prepare(
    "SELECT polar_customer_id, polar_subscription_id, subscription_status FROM workspaces WHERE id = 1",
  ).first<{
    polar_customer_id: string | null;
    polar_subscription_id: string | null;
    subscription_status: string | null;
  }>();

const planAudits = () =>
  env.DB.prepare(
    "SELECT actor_user_id, before, after FROM audit_events WHERE action = 'billing.plan_changed' ORDER BY id",
  )
    .all()
    .then((result) => result.results);

const setPlan = (status: string, periodEnd: number | null) =>
  env.DB.prepare(
    "UPDATE workspaces SET polar_customer_id = 'cus_1', subscription_status = ?, subscription_period_end = ? WHERE id = 1",
  )
    .bind(status, periodEnd)
    .run();

describe("Polar webhook", () => {
  beforeEach(resetAndSeedRepository);
  afterEach(() => {
    vi.restoreAllMocks();
    forgetPlanPrices();
  });

  it("re-reads the workspace's subscriptions from Polar and stores the plan", async () => {
    const calls = polarAnswers([polarSubscription("sub_1", "active")]);

    const response = await deliver(
      subscriptionEvent("subscription.active", { workspace_id: "1" }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ synced: true });
    expect(calls).toHaveLength(1);

    const listUrl = new URL(calls[0]?.url ?? "");

    expect(listUrl.origin + listUrl.pathname).toBe(
      "https://sandbox-api.polar.sh/v1/subscriptions/",
    );
    expect(listUrl.searchParams.get("product_id")).toBe(PRODUCT_ID);
    expect(listUrl.searchParams.get("metadata[workspace_id]")).toBe("1");
    expect(await plan()).toEqual({
      polar_customer_id: "cus_1",
      polar_subscription_id: "sub_1",
      subscription_status: "active",
    });
    expect(await planAudits()).toEqual([
      {
        actor_user_id: null,
        before: '{"status":null}',
        after: '{"status":"active","subscriptionId":"sub_1"}',
      },
    ]);
  });

  it("keeps a new paid subscription whatever order the old one's events arrive in", async () => {
    polarAnswers([
      polarSubscription("sub_new", "active"),
      polarSubscription("sub_old", "canceled"),
    ]);

    await deliver(
      subscriptionEvent("subscription.revoked", { workspace_id: "1" }),
    );
    await deliver(
      subscriptionEvent("subscription.active", { workspace_id: "1" }),
    );

    expect(await plan()).toMatchObject({
      polar_subscription_id: "sub_new",
      subscription_status: "active",
    });
    expect(await planAudits()).toHaveLength(1);
  });

  it("ignores subscriptions to other products or workspaces", async () => {
    polarAnswers([
      polarSubscription("sub_cheap", "active", { productId: "prod-other" }),
      polarSubscription("sub_other", "active", { workspaceId: "2" }),
    ]);

    await deliver(
      subscriptionEvent("subscription.updated", { workspace_id: "1" }),
    );

    expect((await plan())?.subscription_status).toBeNull();
  });

  it("refuses a bad signature or a stale delivery without calling Polar", async () => {
    const calls = polarAnswers([polarSubscription("sub_1", "active")]);

    const body = subscriptionEvent("subscription.active", {
      workspace_id: "1",
    });

    const forged = await deliver(body, {
      signatureFor: subscriptionEvent("subscription.active", {
        workspace_id: "2",
      }),
    });

    const replayed = await deliver(body, {
      sentAt: Date.now() / 1000 - 60 * 60,
    });

    expect(forged.status).toBe(401);
    expect(replayed.status).toBe(401);
    expect(calls).toEqual([]);
    expect((await plan())?.subscription_status).toBeNull();
  });

  it("acknowledges other events, foreign subscriptions, and malformed payloads without syncing", async () => {
    const calls = polarAnswers();

    const responses = await Promise.all([
      deliver(JSON.stringify({ type: "order.paid", data: { id: "ord_1" } })),
      deliver(subscriptionEvent("subscription.active", { plan: "other" })),
      deliver(JSON.stringify({ type: "subscription.active", data: { id: 1 } })),
      deliver(
        subscriptionEvent("subscription.active", { workspace_id: "999" }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      202, 202, 202, 202,
    ]);
    expect(
      await Promise.all(responses.map((response) => response.json())),
    ).toEqual([
      { synced: false },
      { synced: false },
      { synced: false },
      { synced: false },
    ]);
    expect(calls).toEqual([]);
  });

  it("fails so Polar retries when Polar can't be read", async () => {
    polarAnswers([], 503);

    const response = await deliver(
      subscriptionEvent("subscription.active", { workspace_id: "1" }),
    );

    expect(response.status).toBe(500);
    expect((await plan())?.subscription_status).toBeNull();
  });

  it("never lets an older read overwrite a newer one", async () => {
    const apply = (status: string, syncedAt: Date) =>
      Effect.runPromise(
        WorkspaceRepository.applySubscription(
          {
            workspaceId: 1,
            customerId: "cus_1",
            subscriptionId: "sub_1",
            status,
            periodStart: null,
            periodEnd: null,
            cancelAtPeriodEnd: false,
            syncedAt,
          },
          null,
        ).pipe(Effect.provide(makeLiveLayer(env.DB))),
      );

    expect(await apply("canceled", new Date("2026-09-30T12:00:00Z"))).toBe(
      true,
    );
    expect(await apply("active", new Date("2026-09-30T11:00:00Z"))).toBe(false);
    expect((await plan())?.subscription_status).toBe("canceled");
  });
});

describe("paid plan reviews", () => {
  beforeEach(resetAndSeedRepository);

  const choose = async (status: string, periodEnd: number | null) => {
    await setPlan(status, periodEnd);

    const run = await Effect.runPromise(
      ReviewRunRepository.create({
        repositoryId: 1,
        pullRequestNumber: 42,
        headSha: `paid-${status}-${String(periodEnd)}`,
        trigger: "opened",
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    return Effect.runPromise(
      chooseReviewKey(run.id, 1_000, {
        allowanceX100: 20_000,
        vendors: new Set(["google"] as const),
        geminiProvider: "gemini_api",
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );
  };

  it("spends plan credits on the platform key, not the trial", async () => {
    const choice = await choose("active", Date.now() + DAY_MS);

    const [usage] = await Effect.runPromise(
      ReviewRunRepository.trialReviewsUsed([1]).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
      ),
    );

    expect(choice.source).toBe("subscription");
    expect(usage?.used ?? 0).toBe(0);
  });

  it("falls back to the trial when payment is past due, the period lapsed, or has no end", async () => {
    expect((await choose("past_due", Date.now() + DAY_MS)).source).toBe(
      "platform",
    );
    expect((await choose("active", Date.now() - 7 * DAY_MS)).source).toBe(
      "platform",
    );
    expect((await choose("active", null)).source).toBe("platform");
  });
});

describe("billing routes", () => {
  beforeEach(resetAndSeedRepository);
  afterEach(() => {
    vi.restoreAllMocks();
    forgetPlanPrices();
  });

  it("sends an admin to a Polar checkout tagged with the workspace", async () => {
    const calls = polarAnswers();

    const response = await post(
      "/workspaces/1/billing/checkout",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://sandbox.polar.sh/checkout/abc",
    );
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1]).toEqual({
      method: "POST",
      url: "https://sandbox-api.polar.sh/v1/checkouts/",
      body: {
        products: [PRODUCT_ID],
        success_url:
          "https://example.com/workspaces/1/settings?notice=subscribed",
        external_customer_id: "workspace-1",
        metadata: { workspace_id: "1" },
      },
    });
  });

  it("refuses a second checkout when Polar has a payment the webhook hasn't delivered", async () => {
    const calls = polarAnswers([polarSubscription("sub_1", "active")]);
    const cookie = await sessionCookie([3001], "admin");

    const response = await post("/workspaces/1/billing/checkout", cookie);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already has a subscription");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect((await plan())?.subscription_status).toBe("active");

    const page = await (
      await request("/workspaces/1/settings", { headers: { cookie } })
    ).text();

    expect(page).toContain('action="/workspaces/1/billing/portal"');
  });

  it("sends a past-due workspace to the portal instead of a new checkout", async () => {
    await setPlan("past_due", Date.now() + DAY_MS);

    const calls = polarAnswers([polarSubscription("sub_1", "past_due")]);

    const response = await post(
      "/workspaces/1/billing/checkout",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(409);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(await response.text()).toContain(
      'action="/workspaces/1/billing/portal"',
    );
  });

  it("lets a workspace resubscribe when Polar canceled a plan the webhook never reported", async () => {
    await setPlan("active", Date.now() - 7 * DAY_MS);

    const calls = polarAnswers([polarSubscription("sub_1", "canceled")]);

    const response = await post(
      "/workspaces/1/billing/checkout",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(303);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect((await plan())?.subscription_status).toBe("canceled");
  });

  it("keeps Manage billing after the plan ends or moves to another product", async () => {
    await setPlan("canceled", Date.now() - 7 * DAY_MS);

    const page = await (
      await request("/workspaces/1/settings", {
        headers: { cookie: await sessionCookie([3001], "admin") },
      })
    ).text();

    expect(page).toContain('action="/workspaces/1/billing/portal"');
    expect(page).toContain('action="/workspaces/1/billing/checkout"');
  });

  it("opens the customer portal for a subscribed workspace", async () => {
    await setPlan("active", Date.now() + DAY_MS);

    const calls = polarAnswers();

    const response = await post(
      "/workspaces/1/billing/portal",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://sandbox.polar.sh/portal/xyz",
    );
    expect(calls[0]?.body).toEqual({
      external_customer_id: "workspace-1",
      return_url: "https://example.com/workspaces/1/settings",
    });
  });

  it("doesn't let members subscribe", async () => {
    const calls = polarAnswers();

    const response = await post(
      "/workspaces/1/billing/checkout",
      await sessionCookie([3001], "member"),
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("explains a Polar outage instead of failing", async () => {
    polarAnswers([], 500);

    const response = await post(
      "/workspaces/1/billing/checkout",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("so nothing changed");
  });

  it("keeps billing off until the webhook secret is set too", async () => {
    const calls = polarAnswers();
    const cookie = await sessionCookie([3001], "admin");

    const page = await (
      await request(
        "/workspaces/1/settings",
        { headers: { cookie } },
        withoutWebhookSecret,
      )
    ).text();

    const checkout = await post(
      "/workspaces/1/billing/checkout",
      cookie,
      withoutWebhookSecret,
    );

    const webhook = await request(
      "/webhooks/polar",
      { method: "POST", body: "{}" },
      withoutWebhookSecret,
    );

    expect(page).not.toContain("/billing/checkout");
    expect(checkout.status).toBe(404);
    expect(webhook.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("offers admins the checkout on the settings page", async () => {
    polarAnswers();

    const page = await (
      await request("/workspaces/1/settings", {
        headers: { cookie: await sessionCookie([3001], "admin") },
      })
    ).text();

    expect(page).toContain('action="/workspaces/1/billing/checkout"');
    expect(page).toContain("Subscribe for $10/month");
  });
});

describe("paid plan price", () => {
  beforeEach(resetAndSeedRepository);
  afterEach(() => {
    vi.restoreAllMocks();
    forgetPlanPrices();
  });

  const landing = async (testEnv: typeof billingEnv = billingEnv) =>
    (await request("/", {}, testEnv)).text();

  it("shows the price Polar sells the plan for, reading it once", async () => {
    const calls = polarAnswers();

    const first = await landing();
    const second = await landing();

    expect(first).toContain("Fletcher Pro");
    expect(first).toContain("$10");
    expect(first).toContain("for $10/month and skip the key");
    expect(first).not.toContain("Coming soon");
    expect(second).toContain("$10");
    expect(productReads).toBe(1);
    expect(calls).toEqual([]);
  });

  it("still renders when Polar can't be read, without a price", async () => {
    polarAnswers([], 500);

    const page = await landing();

    expect(page).toContain("Fletcher Pro");
    expect(page).toContain("Paid <small>per workspace</small>");
    expect(page).not.toContain("$10");
  });

  it("keeps the last known price through a Polar outage", async () => {
    polarAnswers();
    await landing();
    vi.restoreAllMocks();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    polarAnswers([], 500);

    const page = await landing();
    vi.useRealTimers();

    expect(productReads).toBe(1);
    expect(page).toContain("for $10/month");
  });

  it("calls the plan coming soon without asking Polar when billing is off", async () => {
    const calls = polarAnswers();

    const page = await landing(withoutWebhookSecret);

    expect(page).toContain("Coming soon");
    expect(productReads).toBe(0);
    expect(calls).toEqual([]);
  });
});

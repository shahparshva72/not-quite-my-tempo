import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  GitHubInstallationRepository,
  makeLiveLayer,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";

import app from "../src/index";
import { handleInstallationEvent } from "../src/application/installation-sync";
import { createSession } from "../src/auth/session";
import { encryptToken, tokenContext } from "../src/auth/token-cipher";
import { GitHubAppAuth } from "../src/github/app-auth";
import { GitHubInstallationClient } from "../src/github/installation-client";
import {
  sessionCookie,
  TEST_SESSION_SECRET,
  TEST_TOKEN_ENCRYPTION_KEY,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const derToPem = (der: ArrayBuffer) => {
  let binary = "";

  for (const byte of new Uint8Array(der)) {
    binary += String.fromCharCode(byte);
  }

  return [
    "-----BEGIN PRIVATE KEY-----",
    ...(btoa(binary).match(/.{1,64}/g) ?? []),
    "-----END PRIVATE KEY-----",
  ].join("\n");
};

let privateKeyPem = "";

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  privateKeyPem = derToPem(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  );
});

// Billing is off unless a test turns it on; set explicitly because
// apps/api/.dev.vars may define real POLAR_* values.
const testEnv = () => ({
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: privateKeyPem,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.fletcher",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
  POLAR_ACCESS_TOKEN: "",
  POLAR_PRODUCT_ID: "",
  POLAR_WEBHOOK_SECRET: "",
  POLAR_SERVER: "",
});

const billingEnv = () => ({
  ...testEnv(),
  POLAR_ACCESS_TOKEN: "polar_oat_test",
  POLAR_PRODUCT_ID: "prod-hosted",
  POLAR_SERVER: "sandbox",
  POLAR_WEBHOOK_SECRET: `whsec_${btoa("polar-test-webhook-secret-bytes")}`,
});

const post = (
  path: string,
  cookie: string,
  form: Readonly<Record<string, string>>,
  environment = testEnv(),
) =>
  app.request(
    `https://example.com${path}`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: "https://example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    },
    environment,
  );

const get = (path: string, cookie: string) =>
  app.request(`https://example.com${path}`, { headers: { cookie } }, testEnv());

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

/**
 * Records outbound calls. GitHub answers `githubStatus`; Polar lists
 * `polarSubscriptions`.
 */
const outbound = (
  githubStatus = 204,
  polarSubscriptions: readonly object[] = [],
) => {
  const calls: FetchCall[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);

    calls.push({
      method: init?.method ?? "GET",
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body === undefined ? null : String(init.body),
    });

    return Promise.resolve(
      url.includes("polar.sh")
        ? new Response(
            JSON.stringify({
              items: polarSubscriptions,
              pagination: { total_count: 0, max_page: 1 },
            }),
            { status: 200 },
          )
        : new Response(null, { status: githubStatus }),
    );
  });

  return calls;
};

const count = (sql: string) =>
  env.DB.prepare(sql)
    .first<{ n: number }>()
    .then((row) => row?.n);

/**
 * Workspace 1 ("not-my-tempo", installation 1001, repository 1) has a key,
 * an audit row, and runs: a counted trial review with a finding, a failed
 * trial run with a retry, and a trial review charged to workspace 2 (the
 * repository was transferred in). Workspace 2 ("other-org") has its own
 * installation, repository, and run, and must be left alone.
 */
const seedTwoWorkspaces = async () => {
  await resetAndSeedRepository();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces SET gemini_key_ciphertext = 'cipher', gemini_key_last4 = 'abcd',
         gemini_key_provider = 'gemini_api' WHERE id = 1`,
    ),
    env.DB.prepare(
      `INSERT INTO workspaces (id, github_account_id, github_account_login, account_type)
       VALUES (2, 2002, 'other-org', 'Organization')`,
    ),
    env.DB.prepare(
      `INSERT INTO github_installations
        (id, github_installation_id, github_account_id, github_account_login, account_type, workspace_id)
       VALUES (2, 1002, 2002, 'other-org', 'Organization', 2)`,
    ),
    env.DB.prepare(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
       VALUES (2, 2, 3002, 'other-org', 'api', 'other-org/api', 'main')`,
    ),
    env.DB.prepare(
      `INSERT INTO review_runs
        (id, repository_id, pull_request_number, head_sha, status, trigger, key_source, trial_workspace_id)
       VALUES
        (1, 1, 1, 'a', 'completed', 'opened', 'platform', 1),
        (2, 1, 2, 'b', 'failed', 'opened', 'platform', 1),
        (3, 1, 3, 'c', 'completed', 'opened', 'platform', 2),
        (4, 2, 1, 'd', 'completed', 'opened', 'workspace', NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO findings (review_run_id, file_path, severity, message)
       VALUES (1, 'src/app.ts', 'warning', 'Rushing.'), (4, 'src/api.ts', 'warning', 'Dragging.')`,
    ),
    env.DB.prepare("INSERT INTO review_run_retries (review_run_id) VALUES (2)"),
    env.DB.prepare(
      `INSERT INTO audit_events (workspace_id, action, target)
       VALUES (1, 'role.changed', 'user:9'), (2, 'role.changed', 'user:9')`,
    ),
  ]);
};

const ownerCookie = () => sessionCookie([3001], "owner");

const workspaceRow = (id: number) =>
  env.DB.prepare(
    `SELECT github_account_login, gemini_key_ciphertext, gemini_key_last4,
       trial_reviews_carried, data_deleted_at FROM workspaces WHERE id = ?`,
  )
    .bind(id)
    .first<{
      github_account_login: string;
      gemini_key_ciphertext: string | null;
      gemini_key_last4: string | null;
      trial_reviews_carried: number;
      data_deleted_at: number | null;
    }>();

const nothingDeleted = async () => {
  expect(await count("SELECT count(*) AS n FROM review_runs")).toBe(4);
  expect(await count("SELECT count(*) AS n FROM repositories")).toBe(2);
  expect((await workspaceRow(1))?.gemini_key_last4).toBe("abcd");
};

const trialUsed = (workspaceIds: readonly number[]) =>
  Effect.runPromise(
    ReviewRunRepository.trialReviewsUsed(workspaceIds).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
    ),
  );

describe("deleting a workspace's data", () => {
  beforeEach(seedTwoWorkspaces);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uninstalls the App, then deletes everything but the workspace record", async () => {
    const calls = outbound();
    const cookie = await ownerCookie();

    const response = await post("/workspaces/1/delete", cookie, {
      confirm: "Not-My-Tempo ",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/account?notice=workspace_deleted",
    );
    expect(calls).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: "https://api.github.com/app/installations/1001",
        authorization: expect.stringMatching(/^Bearer ey/),
      }),
    ]);

    // Workspace 1's data is gone...
    expect(
      await count(
        "SELECT count(*) AS n FROM github_installations WHERE workspace_id = 1",
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM repositories WHERE id = 1"),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM review_runs WHERE repository_id = 1",
      ),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM review_run_retries")).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM memberships WHERE workspace_id = 1",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT actor_user_id IS NOT NULL AS by_user, action, after FROM audit_events WHERE workspace_id = 1",
      ).all(),
    ).toMatchObject({
      results: [
        {
          by_user: 1,
          action: "workspace.data_deleted",
          after: '{"repositories":1,"reviews":3}',
        },
      ],
    });

    // ...except the record that keeps the trial from restarting.
    expect(await workspaceRow(1)).toMatchObject({
      github_account_login: "not-my-tempo",
      gemini_key_ciphertext: null,
      gemini_key_last4: null,
      trial_reviews_carried: 1,
      data_deleted_at: expect.any(Number),
    });

    // Workspace 2 keeps its data, and the trial review it paid for in the
    // transferred repository still counts.
    expect(await count("SELECT count(*) AS n FROM review_runs")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM findings")).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE workspace_id = 2",
      ),
    ).toBe(1);
    expect((await workspaceRow(2))?.trial_reviews_carried).toBe(1);
    expect(await trialUsed([1, 2])).toEqual([
      { workspaceId: 1, used: 1 },
      { workspaceId: 2, used: 1 },
    ]);
  });

  it("keeps the used trial when the account installs Fletcher again", async () => {
    outbound();
    await post("/workspaces/1/delete", await ownerCookie(), {
      confirm: "not-my-tempo",
    });

    await env.DB.prepare(
      "UPDATE workspaces SET trial_reviews_carried = 5 WHERE id = 1",
    ).run();

    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const installation = yield* GitHubInstallationRepository.upsert({
          githubInstallationId: 1003,
          githubAccountId: 2001,
          githubAccountLogin: "not-my-tempo",
          accountType: "Organization",
          status: "active",
        });

        yield* Effect.promise(() =>
          env.DB.batch([
            env.DB.prepare(
              `INSERT INTO repositories
                (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
               VALUES (5, ?, 3005, 'not-my-tempo', 'app', 'not-my-tempo/app', 'main')`,
            ).bind(installation.id),
            env.DB.prepare(
              `INSERT INTO review_runs (id, repository_id, pull_request_number, head_sha, status, trigger)
               VALUES (9, 5, 1, 'e', 'running', 'opened')`,
            ),
          ]),
        );

        expect(installation.workspaceId).toBe(1);

        return yield* ReviewRunRepository.claimTrialReview(9, 1, 5, {
          limit: 100,
          since: new Date(0),
        });
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    expect(claimed).toBe(false);
  });

  it("doesn't bring the installation back when GitHub confirms the uninstall", async () => {
    outbound();
    await post("/workspaces/1/delete", await ownerCookie(), {
      confirm: "not-my-tempo",
    });

    const githubLayer = Layer.merge(
      Layer.succeed(
        GitHubAppAuth,
        GitHubAppAuth.of({
          mintInstallationToken: () => Effect.die("not called"),
        }),
      ),
      Layer.succeed(
        GitHubInstallationClient,
        GitHubInstallationClient.of({
          listRepositories: () => Effect.die("not called"),
        }),
      ),
    );

    const result = await Effect.runPromise(
      handleInstallationEvent({
        effect: "remove",
        installationId: 1001,
        accountId: 2001,
        accountLogin: "not-my-tempo",
        accountType: "Organization",
      }).pipe(
        Effect.provide(githubLayer),
        Effect.provide(makeLiveLayer(env.DB)),
      ),
    );

    expect(result).toEqual({ status: "removed" });
    expect(
      await count(
        "SELECT count(*) AS n FROM github_installations WHERE github_installation_id = 1001",
      ),
    ).toBe(0);
  });

  it("treats an installation GitHub already removed as uninstalled", async () => {
    outbound(404);

    const response = await post("/workspaces/1/delete", await ownerCookie(), {
      confirm: "not-my-tempo",
    });

    expect(response.status).toBe(303);
    expect(
      await count(
        "SELECT count(*) AS n FROM review_runs WHERE repository_id = 1",
      ),
    ).toBe(0);
  });

  it("deletes nothing when GitHub can't uninstall the App", async () => {
    outbound(500);

    const response = await post("/workspaces/1/delete", await ownerCookie(), {
      confirm: "not-my-tempo",
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Fletcher wasn&#39;t uninstalled");
    await nothingDeleted();
  });

  it("deletes nothing when the typed name doesn't match", async () => {
    const calls = outbound();

    const response = await post("/workspaces/1/delete", await ownerCookie(), {
      confirm: "other-org",
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("nothing was deleted");
    expect(calls).toEqual([]);
    await nothingDeleted();
  });

  it("is for owners only", async () => {
    const calls = outbound();

    const admin = await post(
      "/workspaces/1/delete",
      await sessionCookie([3001], "admin"),
      { confirm: "not-my-tempo" },
    );

    const outsider = await post("/workspaces/2/delete", await ownerCookie(), {
      confirm: "other-org",
    });

    expect(admin.status).toBe(403);
    expect(outsider.status).toBe(404);
    expect(calls).toEqual([]);
    await nothingDeleted();
  });

  it("shows owners the delete form and others who can delete", async () => {
    const owner = await (
      await get("/workspaces/1/settings", await ownerCookie())
    ).text();

    const admin = await (
      await get("/workspaces/1/settings", await sessionCookie([3001], "admin"))
    ).text();

    expect(owner).toContain('action="/workspaces/1/delete"');
    expect(admin).not.toContain('action="/workspaces/1/delete"');
    expect(admin).toContain("An owner of not-my-tempo on GitHub can delete");
  });

  it("refuses while the stored plan still renews, but not once it's set to end", async () => {
    const calls = outbound();
    const cookie = await ownerCookie();

    await env.DB.prepare(
      "UPDATE workspaces SET polar_customer_id = 'cus_1', subscription_status = 'active' WHERE id = 1",
    ).run();

    const renewing = await post("/workspaces/1/delete", cookie, {
      confirm: "not-my-tempo",
    });

    expect(renewing.status).toBe(409);
    expect(await renewing.text()).toContain("Cancel it in Manage billing");
    expect(calls).toEqual([]);
    await nothingDeleted();

    await env.DB.prepare(
      "UPDATE workspaces SET subscription_cancel_at_period_end = 1 WHERE id = 1",
    ).run();

    const ending = await post("/workspaces/1/delete", cookie, {
      confirm: "not-my-tempo",
    });

    expect(ending.status).toBe(303);
  });

  it("asks Polar, not the stored plan, when billing is on", async () => {
    const calls = outbound(204, [
      {
        id: "sub_1",
        status: "active",
        customer_id: "cus_1",
        product_id: "prod-hosted",
        current_period_end: "2099-01-01T00:00:00Z",
        cancel_at_period_end: false,
        started_at: "2026-09-30T09:00:00Z",
        metadata: { workspace_id: "1" },
      },
    ]);

    const response = await post(
      "/workspaces/1/delete",
      await ownerCookie(),
      { confirm: "not-my-tempo" },
      billingEnv(),
    );

    expect(response.status).toBe(409);
    // The settings page shown with the error also reads the plan's price.
    expect(calls.filter((call) => !call.url.includes("/v1/products/"))).toEqual(
      [
        expect.objectContaining({
          url: expect.stringContaining(
            "https://sandbox-api.polar.sh/v1/subscriptions/",
          ),
        }),
      ],
    );
    await nothingDeleted();
  });
});

/** A session holding an encrypted GitHub token, as a real sign-in makes. */
const sessionWithToken = async (githubToken: string) => {
  await sessionCookie([3001], "owner");

  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE github_user_id = 4001",
  ).first<{ id: number }>();

  const userId = user?.id ?? 0;

  const token = await Effect.runPromise(
    Effect.gen(function* () {
      const ciphertext = yield* encryptToken(
        TEST_TOKEN_ENCRYPTION_KEY,
        githubToken,
        tokenContext(userId),
      );

      return yield* createSession(
        TEST_SESSION_SECRET,
        userId,
        [3001],
        ciphertext,
      );
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

  return { userId, cookie: `nqmt_session=${token}` };
};

describe("deleting an account", () => {
  beforeEach(seedTwoWorkspaces);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the user, their sessions and roles, and revokes the GitHub grant", async () => {
    const calls = outbound();
    const { userId, cookie } = await sessionWithToken("ghu_fletcher_token");

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workspaces SET gemini_key_updated_by = ? WHERE id = 1",
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO audit_events (workspace_id, actor_user_id, action, target)
         VALUES (1, ?, 'gemini_key.saved', 'workspace:1')`,
      ).bind(userId),
    ]);

    const response = await post("/account/delete", cookie, {
      confirm: "neiman",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/account/deleted");
    expect(response.headers.get("set-cookie")).toContain("nqmt_session=;");

    expect(await count("SELECT count(*) AS n FROM users")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sessions")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM memberships")).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT gemini_key_updated_by FROM workspaces WHERE id = 1",
      ).first(),
    ).toEqual({ gemini_key_updated_by: null });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'gemini_key.saved' AND actor_user_id IS NULL",
      ),
    ).toBe(1);

    // Workspaces belong to their GitHub accounts and stay.
    await nothingDeleted();

    expect(calls).toEqual([
      {
        method: "DELETE",
        url: "https://api.github.com/applications/Iv1.fletcher/grant",
        authorization: `Basic ${btoa("Iv1.fletcher:oauth-secret")}`,
        body: JSON.stringify({ access_token: "ghu_fletcher_token" }),
      },
    ]);

    const goodbye = await app.request(
      "https://example.com/account/deleted",
      {},
      testEnv(),
    );

    expect(goodbye.status).toBe(200);
    expect(await goodbye.text()).toContain("Your account is deleted");
  });

  it("still deletes the account when GitHub won't revoke the grant", async () => {
    outbound(500);
    const { cookie } = await sessionWithToken("ghu_fletcher_token");

    const response = await post("/account/delete", cookie, {
      confirm: "neiman",
    });

    expect(response.status).toBe(303);
    expect(await count("SELECT count(*) AS n FROM users")).toBe(0);
  });

  it("deletes nothing when the typed username doesn't match", async () => {
    const calls = outbound();
    const cookie = await ownerCookie();

    const response = await post("/account/delete", cookie, {
      confirm: "fletcher",
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("nothing was deleted");
    expect(await count("SELECT count(*) AS n FROM users")).toBe(1);
    expect(calls).toEqual([]);
  });

  it("lists the user's workspaces and warns about the ones they own", async () => {
    const body = await (await get("/account", await ownerCookie())).text();

    expect(body).toContain('href="/workspaces/1/settings"');
    expect(body).toContain("Deleting your account doesn't delete");
    expect(body).toContain('action="/account/delete"');
  });
});

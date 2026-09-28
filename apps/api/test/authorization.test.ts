import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";
import type { WorkspaceRole } from "@not-quite-my-tempo/db";

import app from "../src/index";
import {
  repositoryActionAllowed,
  roleAllows,
} from "../src/application/authorization";
import { createSession } from "../src/auth/session";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = {
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  GITHUB_APP_SLUG: "fletcher-test",
};

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

const toggle = (
  repositoryId: number,
  cookie: string,
  headers: Record<string, string> = { origin: "https://example.com" },
) =>
  request(`/onboarding/repositories/${repositoryId}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: "enabled=false&return=repository",
  });

const enabledOf = (repositoryId: number) =>
  env.DB.prepare("SELECT enabled FROM repositories WHERE id = ?")
    .bind(repositoryId)
    .first<{ enabled: number }>()
    .then((row) => row?.enabled);

const auditRows = () =>
  env.DB.prepare(
    "SELECT workspace_id, actor_user_id, action, target, before, after FROM audit_events",
  )
    .all()
    .then((result) => result.results);

// A second tenant: workspace 2 (account 2002) with installation 1002 and
// repository 2 (GitHub 3002), and a second user (GitHub 4002) who belongs
// only to it.
const seedSecondWorkspace = () =>
  env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, github_account_id, github_account_login, account_type)
       VALUES (2, 2002, 'other-band', 'Organization')`,
    ),
    env.DB.prepare(
      `INSERT INTO github_installations
        (id, github_installation_id, github_account_id, github_account_login, account_type, workspace_id)
       VALUES (2, 1002, 2002, 'other-band', 'Organization', 2)`,
    ),
    env.DB.prepare(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, full_name, default_branch)
       VALUES (2, 2, 3002, 'other-band', 'secret', 'other-band/secret', 'main')`,
    ),
  ]);

const otherUserCookie = async (repositoryIds: readonly number[]) => {
  const user = await env.DB.prepare(
    `INSERT INTO users (github_user_id, login) VALUES (4002, 'andrew') RETURNING id`,
  ).first<{ id: number }>();

  await env.DB.prepare(
    `INSERT INTO memberships (workspace_id, user_id, app_role, verified_at)
     VALUES (2, ?, 'admin', 0)`,
  )
    .bind(user?.id)
    .run();

  const token = await Effect.runPromise(
    createSession(TEST_SESSION_SECRET, user?.id ?? 0, repositoryIds).pipe(
      Effect.provide(makeLiveLayer(env.DB)),
    ),
  );

  return `nqmt_session=${token}`;
};

describe("role rules", () => {
  it("ranks owner above admin above member", () => {
    const roles: readonly WorkspaceRole[] = ["member", "admin", "owner"];

    expect(
      roles.map((role) => [
        repositoryActionAllowed(role, "view"),
        repositoryActionAllowed(role, "toggle_reviews"),
        roleAllows(role, "owner"),
      ]),
    ).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });
});

describe("turning reviews on or off", () => {
  beforeEach(resetAndSeedRepository);

  it("refuses members with a 403 page and changes nothing", async () => {
    const response = await toggle(1, await sessionCookie([3001], "member"));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("You need admin access");
    expect(await enabledOf(1)).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  it.each(["admin", "owner"] as const)(
    "lets an %s change it and records who did",
    async (role) => {
      const response = await toggle(1, await sessionCookie([3001], role));

      const user = await env.DB.prepare(
        "SELECT id FROM users WHERE github_user_id = 4001",
      ).first<{ id: number }>();

      expect(response.status).toBe(303);
      expect(await enabledOf(1)).toBe(0);
      expect(await auditRows()).toEqual([
        {
          workspace_id: 1,
          actor_user_id: user?.id,
          action: "repository.reviews_toggled",
          target: "repository:1",
          before: '{"enabled":true}',
          after: '{"enabled":false}',
        },
      ]);
    },
  );

  it("shows members the state and who can change it, not the switch", async () => {
    const body = await (
      await request("/dashboard/repositories/1", {
        headers: { cookie: await sessionCookie([3001], "member") },
      })
    ).text();

    expect(body).toContain("Ask an admin to change this");
    expect(body).not.toContain('role="switch"');
  });

  it.each([
    ["no Origin header", {}],
    [
      "a cross-site fetch",
      { origin: "https://example.com", "sec-fetch-site": "cross-site" },
    ],
    ["another origin", { origin: "https://evil.example" }],
  ] as const)("rejects form posts with %s", async (_label, headers) => {
    const response = await toggle(1, await sessionCookie([3001]), headers);

    expect(response.status).toBe(403);
    expect(await enabledOf(1)).toBe(1);
  });
});

describe("workspace isolation", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await seedSecondWorkspace();
  });

  it("hides another workspace's repository even when GitHub lists it", async () => {
    // GitHub says the user can see 3002, but they aren't in workspace 2.
    const cookie = await sessionCookie([3001, 3002]);

    const dashboard = await (
      await request("/dashboard", { headers: { cookie } })
    ).text();

    expect(dashboard).toContain("not-my-tempo/app");
    expect(dashboard).not.toContain("other-band/secret");
    expect(
      (await request("/dashboard/repositories/2", { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect((await toggle(2, cookie)).status).toBe(404);
    expect(await enabledOf(2)).toBe(1);
  });

  it("hides a member's own workspace repository GitHub no longer lists", async () => {
    const cookie = await sessionCookie([]);

    expect(
      (await request("/dashboard/repositories/1", { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect((await toggle(1, cookie)).status).toBe(404);
  });

  it("keeps two tenants apart in both directions", async () => {
    const otherCookie = await otherUserCookie([3001, 3002]);

    const api = await request("/api/repositories", {
      headers: { cookie: otherCookie },
    });

    const { repositories } = await api.json<{
      repositories: readonly { fullName: string }[];
    }>();

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "other-band/secret",
    ]);
    expect((await toggle(1, otherCookie)).status).toBe(404);
    expect(await enabledOf(1)).toBe(1);
  });
});

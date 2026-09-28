import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

// A second person in workspace 1, plus an owner who isn't the viewer.
const seedOtherMembers = async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, github_user_id, login) VALUES (50, 4003, 'andrew'), (51, 4004, 'terence')",
    ),
    env.DB.prepare(
      `INSERT INTO memberships (workspace_id, user_id, github_owner, app_role, verified_at)
       VALUES (1, 50, 0, 'member', 0), (1, 51, 1, 'member', 0)`,
    ),
  ]);
};

const setRole = (
  userId: number,
  role: string,
  cookie: string,
  origin = "https://example.com",
) =>
  request(`/workspaces/1/members/${userId}/role`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `role=${role}`,
  });

const appRoleOf = (userId: number) =>
  env.DB.prepare(
    "SELECT app_role FROM memberships WHERE workspace_id = 1 AND user_id = ?",
  )
    .bind(userId)
    .first<{ app_role: string }>()
    .then((row) => row?.app_role);

const roleAudits = () =>
  env.DB.prepare(
    "SELECT target, before, after FROM audit_events WHERE action = 'role.changed' ORDER BY id",
  )
    .all()
    .then((result) => result.results);

describe("members page", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await seedOtherMembers();
  });

  it("lists members with roles and gives owners the controls", async () => {
    const body = await (
      await request("/workspaces/1/members", {
        headers: { cookie: await sessionCookie([3001], "owner") },
      })
    ).text();

    expect(body).toContain("Members of not-my-tempo");
    expect(body).toContain("neiman (you)");
    expect(body).toContain("andrew");
    expect(body).toContain("Owner on GitHub");
    expect(body).toContain("Make admin");
    expect(body).toContain('action="/workspaces/1/members/50/role"');
    // No control next to the other owner.
    expect(body).not.toContain('action="/workspaces/1/members/51/role"');
  });

  it("shows admins and members the list without controls", async () => {
    const body = await (
      await request("/workspaces/1/members", {
        headers: { cookie: await sessionCookie([3001], "admin") },
      })
    ).text();

    expect(body).toContain("andrew");
    expect(body).not.toContain("Make admin");
  });

  it("explains a workspace with no owner signed in", async () => {
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = 51").run();

    const body = await (
      await request("/workspaces/1/members", {
        headers: { cookie: await sessionCookie([3001], "member") },
      })
    ).text();

    expect(body).toContain("No owner has signed in yet");
  });

  it("returns 404 for a workspace the user doesn't belong to", async () => {
    const cookie = await sessionCookie([3001]);

    expect(
      (await request("/workspaces/999/members", { headers: { cookie } }))
        .status,
    ).toBe(404);
  });
});

describe("changing admin roles", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await seedOtherMembers();
  });

  it("lets an owner make a member an admin and back, recording each change", async () => {
    const cookie = await sessionCookie([3001], "owner");

    const promote = await setRole(50, "admin", cookie);

    expect(promote.status).toBe(303);
    expect(promote.headers.get("location")).toBe("/workspaces/1/members");
    expect(await appRoleOf(50)).toBe("admin");

    // A repeated submit changes nothing and records nothing.
    await setRole(50, "admin", cookie);
    await setRole(50, "member", cookie);

    expect(await appRoleOf(50)).toBe("member");
    expect(await roleAudits()).toEqual([
      {
        target: "user:50",
        before: '{"role":"member"}',
        after: '{"role":"admin"}',
      },
      {
        target: "user:50",
        before: '{"role":"admin"}',
        after: '{"role":"member"}',
      },
    ]);
  });

  it("refuses admins with a 403 page", async () => {
    const response = await setRole(
      50,
      "admin",
      await sessionCookie([3001], "admin"),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Only owners can do this");
    expect(await appRoleOf(50)).toBe("member");
  });

  it("won't change an owner's role, which comes from GitHub", async () => {
    const response = await setRole(
      51,
      "member",
      await sessionCookie([3001], "owner"),
    );

    expect(response.status).toBe(400);
    expect(await roleAudits()).toEqual([]);
  });

  it("returns 404 for someone outside the workspace", async () => {
    const response = await setRole(
      999,
      "admin",
      await sessionCookie([3001], "owner"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects role changes posted from another site", async () => {
    const response = await setRole(
      50,
      "admin",
      await sessionCookie([3001], "owner"),
      "https://evil.example",
    );

    expect(response.status).toBe(403);
    expect(await appRoleOf(50)).toBe("member");
  });
});

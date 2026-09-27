import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = {
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  GITHUB_APP_SLUG: "fletcher-test",
};

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

const toggle = (repositoryId: number, enabled: string, cookie: string) =>
  request(`/onboarding/repositories/${repositoryId}`, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ enabled }).toString(),
  });

const repositoryEnabled = () =>
  env.DB.prepare("SELECT enabled FROM repositories WHERE id = 1")
    .first<{ enabled: number }>()
    .then((row) => row?.enabled);

describe("onboarding", () => {
  beforeEach(resetAndSeedRepository);

  it("asks signed-out visitors to sign in", async () => {
    const response = await request("/onboarding");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/auth/login"');
  });

  it("links to the GitHub App install page and lists repositories", async () => {
    const cookie = await sessionCookie([3001]);

    const response = await request("/onboarding", { headers: { cookie } });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "https://github.com/apps/fletcher-test/installations/new",
    );
    expect(body).toContain("not-my-tempo/app");
    expect(body).toContain('aria-label="Reviews for not-my-tempo/app"');
    expect(body).toContain('aria-checked="true"');
  });

  it("shows install guidance when the user has no repositories", async () => {
    const cookie = await sessionCookie([]);

    const body = await (
      await request("/onboarding", { headers: { cookie } })
    ).text();

    expect(body).toContain("Install on GitHub");
    expect(body).not.toContain("not-my-tempo/app");
  });

  it("holds the installation ID and re-verifies it through sign-in", async () => {
    const response = await request(
      "/onboarding/callback?installation_id=1234&setup_action=install",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/login?next=onboarding",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "nqmt_pending_installation=1234",
    );
  });

  it("explains installs awaiting organization approval", async () => {
    const response = await request("/onboarding/callback?setup_action=request");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Waiting for approval");
  });

  it("ignores a callback without a valid installation ID", async () => {
    const response = await request("/onboarding/callback?installation_id=x");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("shows a switched-off repository as off", async () => {
    await env.DB.prepare(
      "UPDATE repositories SET enabled = 0 WHERE id = 1",
    ).run();
    const cookie = await sessionCookie([3001]);

    const body = await (
      await request("/onboarding", { headers: { cookie } })
    ).text();

    expect(body).toContain('aria-checked="false"');
    expect(body).toContain("Reviews off");
  });

  it("turns reviews off and back on for an accessible repository", async () => {
    const cookie = await sessionCookie([3001]);

    const off = await toggle(1, "false", cookie);

    expect(off.status).toBe(303);
    expect(off.headers.get("location")).toBe("/onboarding");
    expect(await repositoryEnabled()).toBe(0);

    await toggle(1, "true", cookie);

    expect(await repositoryEnabled()).toBe(1);
  });

  it("refuses to change repositories outside the session's access", async () => {
    const cookie = await sessionCookie([9999]);

    const response = await toggle(1, "false", cookie);

    expect(response.status).toBe(404);
    expect(await repositoryEnabled()).toBe(1);
  });

  it("rejects cross-origin toggles", async () => {
    const cookie = await sessionCookie([3001]);

    const response = await request("/onboarding/repositories/1", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "enabled=false",
    });

    expect(response.status).toBe(403);
    expect(await repositoryEnabled()).toBe(1);
  });
});

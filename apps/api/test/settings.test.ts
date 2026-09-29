import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { geminiKeyContext } from "../src/application/workspace-settings";
import { decryptToken } from "../src/auth/token-cipher";
import {
  sessionCookie,
  TEST_SESSION_SECRET,
  TEST_TOKEN_ENCRYPTION_KEY,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = {
  ...env,
  SESSION_SECRET: TEST_SESSION_SECRET,
  TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,
};

const API_KEY = "AIzaSyTestKeyForFletcher1234567890";

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

const post = (path: string, cookie: string, body = "") =>
  request(path, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

const saveKey = (cookie: string, apiKey = API_KEY) =>
  post(
    "/workspaces/1/settings/gemini-key",
    cookie,
    new URLSearchParams({ api_key: apiKey }).toString(),
  );

// Answers Gemini's model-list check; everything else is unexpected.
const geminiAnswers = (status: number) => {
  const calls: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    calls.push(String(input));

    return Promise.resolve(new Response("{}", { status }));
  });

  return calls;
};

const workspaceKey = () =>
  env.DB.prepare(
    "SELECT gemini_key_ciphertext, gemini_key_last4 FROM workspaces WHERE id = 1",
  ).first<{
    gemini_key_ciphertext: string | null;
    gemini_key_last4: string | null;
  }>();

const keyAudits = () =>
  env.DB.prepare(
    "SELECT action, before, after FROM audit_events WHERE action LIKE 'gemini_key.%' ORDER BY id",
  )
    .all()
    .then((result) => result.results);

describe("workspace settings: Gemini key", () => {
  beforeEach(resetAndSeedRepository);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows members the trial status without the form", async () => {
    const body = await (
      await request("/workspaces/1/settings", {
        headers: { cookie: await sessionCookie([3001], "member") },
      })
    ).text();

    expect(body).toContain("5 of 5 free reviews are left");
    expect(body).toContain("Only admins and owners can change the key.");
    expect(body).not.toContain('name="api_key"');
  });

  it("checks, encrypts, and stores a key an admin saves, showing only its last 4", async () => {
    const calls = geminiAnswers(200);
    const cookie = await sessionCookie([3001], "admin");

    const response = await saveKey(cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/workspaces/1/settings?notice=saved",
    );
    expect(calls).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    ]);

    const stored = await workspaceKey();

    expect(stored?.gemini_key_last4).toBe("7890");
    expect(stored?.gemini_key_ciphertext).not.toContain(API_KEY);
    expect(
      await Effect.runPromise(
        decryptToken(
          TEST_TOKEN_ENCRYPTION_KEY,
          stored?.gemini_key_ciphertext ?? "",
          geminiKeyContext(1),
        ),
      ),
    ).toBe(API_KEY);
    expect(await keyAudits()).toEqual([
      {
        action: "gemini_key.saved",
        before: '{"last4":null}',
        after: '{"last4":"7890"}',
      },
    ]);

    const page = await (
      await request("/workspaces/1/settings?notice=saved", {
        headers: { cookie },
      })
    ).text();

    expect(page).toContain("Key saved. Reviews now use it.");
    expect(page).toContain("…7890");
    expect(page).not.toContain(API_KEY);
    expect(page).not.toContain(stored?.gemini_key_ciphertext ?? "missing");
  });

  it("refuses malformed keys without calling Google", async () => {
    const calls = geminiAnswers(200);

    const response = await saveKey(
      await sessionCookie([3001], "admin"),
      "GEMINI_API_KEY=abc def",
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("doesn&#39;t look like");
    expect(calls).toEqual([]);
    expect((await workspaceKey())?.gemini_key_last4).toBeNull();
  });

  it("doesn't store a key Google rejects", async () => {
    geminiAnswers(400);

    const response = await saveKey(await sessionCookie([3001], "admin"));

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Google rejected that key");
    expect((await workspaceKey())?.gemini_key_last4).toBeNull();
  });

  it("doesn't store a key it couldn't check", async () => {
    geminiAnswers(503);

    const response = await saveKey(await sessionCookie([3001], "admin"));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Google didn&#39;t answer");
    expect((await workspaceKey())?.gemini_key_last4).toBeNull();
  });

  it("refuses members with a 403", async () => {
    const calls = geminiAnswers(200);

    const response = await saveKey(await sessionCookie([3001], "member"));

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("removes the key once, recording it once", async () => {
    geminiAnswers(200);
    const cookie = await sessionCookie([3001], "owner");

    await saveKey(cookie);

    const removed = await post(
      "/workspaces/1/settings/gemini-key/remove",
      cookie,
    );

    await post("/workspaces/1/settings/gemini-key/remove", cookie);

    expect(removed.headers.get("location")).toBe(
      "/workspaces/1/settings?notice=removed",
    );
    expect(await workspaceKey()).toEqual({
      gemini_key_ciphertext: null,
      gemini_key_last4: null,
    });
    expect((await keyAudits()).map((row) => row["action"])).toEqual([
      "gemini_key.saved",
      "gemini_key.removed",
    ]);
  });
});

describe("dashboard key status", () => {
  beforeEach(resetAndSeedRepository);

  const dashboard = async () =>
    (
      await request("/dashboard", {
        headers: { cookie: await sessionCookie([3001], "member") },
      })
    ).text();

  it("shows the trial, the workspace key, or paused reviews", async () => {
    expect(await dashboard()).toContain("5 of 5 free reviews left.");

    await env.DB.prepare(
      "UPDATE workspaces SET trial_reviews_used = 5 WHERE id = 1",
    ).run();

    expect(await dashboard()).toContain(
      "Free reviews used up. Reviews are paused.",
    );

    await env.DB.prepare(
      "UPDATE workspaces SET gemini_key_ciphertext = 'v1.x.y', gemini_key_last4 = 'abcd' WHERE id = 1",
    ).run();

    const body = await dashboard();

    expect(body).toContain("Reviews use this workspace's Gemini key.");
    expect(body).not.toContain("v1.x.y");
  });
});

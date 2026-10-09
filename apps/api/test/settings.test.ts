import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { reviewKeyContext } from "../src/application/workspace-settings";
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

const saveKey = (cookie: string, apiKey = API_KEY, vendor = "google") =>
  post(
    "/workspaces/1/settings/review-key",
    cookie,
    new URLSearchParams({ vendor, api_key: apiKey }).toString(),
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
    "SELECT action, before, after FROM audit_events WHERE action LIKE 'review_key.%' ORDER BY id",
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
    expect(body).toContain(
      "Only admins and owners can change the key or model.",
    );
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
          reviewKeyContext(1, "gemini_api"),
        ),
      ),
    ).toBe(API_KEY);
    expect(await keyAudits()).toEqual([
      {
        action: "review_key.saved",
        before: '{"last4":null}',
        after: '{"last4":"7890","provider":"gemini_api"}',
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

  it("accepts Google's newer key format, which contains dots", async () => {
    const calls = geminiAnswers(200);
    const newFormatKey = "AQ.test-only-fake-new-format-key-0123456789ab_XYZ";

    const response = await saveKey(
      await sessionCookie([3001], "admin"),
      newFormatKey,
    );

    expect(response.status).toBe(303);
    expect(calls).toHaveLength(1);
    expect((await workspaceKey())?.gemini_key_last4).toBe("_XYZ");
  });

  it("saves a Vertex AI key after the Gemini API refuses it", async () => {
    const calls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      calls.push(String(input));

      return Promise.resolve(
        new Response("{}", {
          status: String(input).includes("aiplatform") ? 200 : 403,
        }),
      );
    });

    const cookie = await sessionCookie([3001], "admin");
    const vertexKey = "AQ.test-only-fake-vertex-key-for-settings-tests_VRTX";

    expect((await saveKey(cookie, vertexKey)).status).toBe(303);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("aiplatform.googleapis.com");

    const stored = await env.DB.prepare(
      "SELECT gemini_key_provider, gemini_key_last4 FROM workspaces WHERE id = 1",
    ).first();

    expect(stored).toEqual({
      gemini_key_provider: "vertex_express",
      gemini_key_last4: "VRTX",
    });

    const page = await (
      await request("/workspaces/1/settings", { headers: { cookie } })
    ).text();

    expect(page).toContain("Vertex AI");
    expect(page).not.toContain(vertexKey);
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
    expect(await response.text()).toContain("The provider rejected that key");
    expect((await workspaceKey())?.gemini_key_last4).toBeNull();
  });

  it("doesn't store a key it couldn't check", async () => {
    geminiAnswers(503);

    const response = await saveKey(await sessionCookie([3001], "admin"));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("The provider didn&#39;t answer");
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
      "/workspaces/1/settings/review-key/remove",
      cookie,
    );

    await post("/workspaces/1/settings/review-key/remove", cookie);

    expect(removed.headers.get("location")).toBe(
      "/workspaces/1/settings?notice=removed",
    );
    expect(await workspaceKey()).toEqual({
      gemini_key_ciphertext: null,
      gemini_key_last4: null,
    });
    expect((await keyAudits()).map((row) => row["action"])).toEqual([
      "review_key.saved",
      "review_key.removed",
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

    // Five completed reviews on the platform key use up the trial.
    for (let index = 0; index < 5; index += 1) {
      await env.DB.prepare(
        `INSERT INTO review_runs (repository_id, pull_request_number, head_sha, status, trigger, key_source, trial_workspace_id)
         VALUES (1, ?, ?, 'completed', 'opened', 'platform', 1)`,
      )
        .bind(200 + index, `trial-${index}`)
        .run();
    }

    expect(await dashboard()).toContain(
      "Free reviews used up. Reviews are paused.",
    );

    await env.DB.prepare(
      "UPDATE workspaces SET gemini_key_ciphertext = 'v1.x.y', gemini_key_last4 = 'abcd' WHERE id = 1",
    ).run();

    const body = await dashboard();

    expect(body).toContain("Reviews use this workspace&#39;s Gemini API key.");
    expect(body).not.toContain("v1.x.y");
  });
});

describe("workspace settings: providers and models", () => {
  beforeEach(resetAndSeedRepository);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Answers Gemini's model list with current and old models.
  const providerAnswers = (status = 200) => {
    const calls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      calls.push(String(input));

      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-3.8-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-3.7-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-2.5-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-embedding-001",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          }),
          { status },
        ),
      );
    });

    return calls;
  };

  const storedProvider = () =>
    env.DB.prepare(
      "SELECT gemini_key_provider, gemini_key_last4, review_model, plan_model FROM workspaces WHERE id = 1",
    ).first();

  it("refuses OpenAI and Anthropic keys while only Gemini is enabled", async () => {
    const calls = providerAnswers();
    const cookie = await sessionCookie([3001], "admin");

    for (const [vendor, apiKey] of [
      ["openai", "sk-proj-test-only-fake-openai-key-1234"],
      ["anthropic", "sk-ant-api03-test-only-fake-anthropic-key"],
    ] as const) {
      const response = await saveKey(cookie, apiKey, vendor);

      expect(response.status).toBe(422);
      expect(await response.text()).toContain(
        "Only Gemini keys are supported for now.",
      );
    }

    expect(calls).toEqual([]);
    expect(await storedProvider()).toMatchObject({ gemini_key_last4: null });

    const page = await (
      await request("/workspaces/1/settings", { headers: { cookie } })
    ).text();

    expect(page).not.toContain('value="openai"');
    expect(page).not.toContain('value="anthropic"');
  });

  it("lets admins pick a model their key can use, and nothing else", async () => {
    providerAnswers();
    const cookie = await sessionCookie([3001], "admin");

    await saveKey(cookie);

    const page = await (
      await request("/workspaces/1/settings", { headers: { cookie } })
    ).text();

    expect(page).toContain('<option value="gemini-3.7-flash"');
    // Older generations and non-chat models aren't offered.
    expect(page).not.toContain('value="gemini-2.5-flash"');
    expect(page).not.toContain('value="gemini-embedding-001"');

    const saved = await post(
      "/workspaces/1/settings/review-model",
      cookie,
      new URLSearchParams({ model: "gemini-3.7-flash" }).toString(),
    );

    expect(saved.headers.get("location")).toBe(
      "/workspaces/1/settings?notice=model_saved",
    );
    expect((await storedProvider())?.["review_model"]).toBe("gemini-3.7-flash");

    const refused = await post(
      "/workspaces/1/settings/review-model",
      cookie,
      new URLSearchParams({ model: "gemini-2.5-flash" }).toString(),
    );

    expect(refused.status).toBe(422);
    expect((await storedProvider())?.["review_model"]).toBe("gemini-3.7-flash");
  });

  it("only offers plan models from the catalog's allowed tiers", async () => {
    const cookie = await sessionCookie([3001], "admin");

    const saved = await post(
      "/workspaces/1/settings/plan-model",
      cookie,
      new URLSearchParams({ model: "gemini-3.5-flash" }).toString(),
    );

    expect(saved.status).toBe(303);
    expect((await storedProvider())?.["plan_model"]).toBe("gemini-3.5-flash");

    const expensive = await post(
      "/workspaces/1/settings/plan-model",
      cookie,
      new URLSearchParams({ model: "claude-opus-5-5" }).toString(),
    );

    expect(expensive.status).toBe(422);
    expect((await storedProvider())?.["plan_model"]).toBe("gemini-3.5-flash");
  });
});

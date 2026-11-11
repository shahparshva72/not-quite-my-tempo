import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

const setRunner = (form: Record<string, string>, cookie: string) =>
  request("/dashboard/repositories/1/review-runner", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });

const stored = () =>
  env.DB.prepare(
    "SELECT review_runner, runner_model FROM repositories WHERE id = 1",
  ).first<{ review_runner: string; runner_model: string | null }>();

describe("repository review runner", () => {
  beforeEach(resetAndSeedRepository);

  it("saves the picked runner's model and ignores the other picker", async () => {
    const cookie = await sessionCookie([3001], "admin");

    const response = await setRunner(
      {
        runner: "codex_actions",
        claudeModel: "claude-opus-5-5",
        codexModel: "gpt-6-astra",
      },
      cookie,
    );

    expect(response.status).toBe(303);
    expect(await stored()).toEqual({
      review_runner: "codex_actions",
      runner_model: "gpt-6-astra",
    });

    const page = await (
      await request("/dashboard/repositories/1", { headers: { cookie } })
    ).text();

    expect(page).toMatch(/<option\s+value="codex_actions"\s+selected/);
    expect(page).toMatch(/<option\s+value="gpt-6-astra"\s+selected/);
    expect(page).toContain('href="/docs#chatgpt-subscription"');
  });

  it("keeps the runner model when reviews go back to Fletcher", async () => {
    const cookie = await sessionCookie([3001], "admin");

    await setRunner(
      { runner: "claude_actions", claudeModel: "claude-opus-5-5" },
      cookie,
    );
    await setRunner({ runner: "fletcher", claudeModel: "" }, cookie);

    expect(await stored()).toEqual({
      review_runner: "fletcher",
      runner_model: "claude-opus-5-5",
    });
  });

  it("refuses another vendor's model for the picked runner", async () => {
    const cookie = await sessionCookie([3001], "admin");

    const response = await setRunner(
      { runner: "codex_actions", codexModel: "claude-opus-5-5" },
      cookie,
    );

    expect(response.status).toBe(404);
    expect(await stored()).toEqual({
      review_runner: "fletcher",
      runner_model: null,
    });
  });
});

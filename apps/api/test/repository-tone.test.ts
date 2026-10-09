import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer } from "@not-quite-my-tempo/db";

import app from "../src/index";
import { repositoryReviewTone } from "../src/application/review-workflow";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";
import { resetAndSeedRepository } from "./database";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, testEnv);

const setTone = (tone: string, cookie: string, repositoryId = 1) =>
  request(`/dashboard/repositories/${repositoryId}/review-tone`, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://example.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ tone }).toString(),
  });

const storedTone = (repositoryId = 1) =>
  env.DB.prepare("SELECT review_tone FROM repositories WHERE id = ?")
    .bind(repositoryId)
    .first<{ review_tone: string | null }>()
    .then((row) => row?.review_tone);

describe("repository review tone", () => {
  beforeEach(resetAndSeedRepository);

  it("lets an admin pick ruthless for one repository, and clear it", async () => {
    const cookie = await sessionCookie([3001], "admin");

    const saved = await setTone("ruthless", cookie);

    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/dashboard/repositories/1");
    expect(await storedTone()).toBe("ruthless");

    const page = await (
      await request("/dashboard/repositories/1", { headers: { cookie } })
    ).text();

    expect(page).toMatch(/<option\s+value="ruthless"\s+selected/);

    await setTone("", cookie);

    expect(await storedTone()).toBeNull();

    const audits = await env.DB.prepare(
      "SELECT before, after FROM audit_events WHERE action = 'repository.review_tone_changed' ORDER BY id",
    ).all();

    expect(audits.results).toEqual([
      { before: '{"reviewTone":null}', after: '{"reviewTone":"ruthless"}' },
      { before: '{"reviewTone":"ruthless"}', after: '{"reviewTone":null}' },
    ]);
  });

  it("shows members the tone without letting them change it", async () => {
    await env.DB.prepare(
      "UPDATE repositories SET review_tone = 'ruthless' WHERE id = 1",
    ).run();
    const cookie = await sessionCookie([3001], "member");

    const page = await (
      await request("/dashboard/repositories/1", { headers: { cookie } })
    ).text();

    expect(page).toContain("Ruthless: full Fletcher");
    expect(page).not.toContain('name="tone"');

    const response = await setTone("standard", cookie);

    expect(response.status).toBe(403);
    expect(await storedTone()).toBe("ruthless");
  });

  it("refuses unknown tones and repositories outside the session", async () => {
    const admin = await sessionCookie([3001], "admin");

    expect((await setTone("loud", admin)).status).toBe(404);

    const outsider = await sessionCookie([9999], "admin");

    expect((await setTone("ruthless", outsider)).status).toBe(404);
    expect(await storedTone()).toBeNull();
  });

  it("hands the run's repository tone to the review, or null to follow the file", async () => {
    const run = await env.DB.prepare(
      "INSERT INTO review_runs (repository_id, pull_request_number, head_sha, status, trigger) VALUES (1, 7, 'tone123', 'queued', 'opened') RETURNING id",
    ).first<{ id: number }>();

    const reviewRunId = run?.id ?? 0;

    const tone = () =>
      Effect.runPromise(
        repositoryReviewTone(reviewRunId).pipe(
          Effect.provide(makeLiveLayer(env.DB)),
        ),
      );

    expect(await tone()).toBeNull();

    await env.DB.prepare(
      "UPDATE repositories SET review_tone = 'ruthless' WHERE id = 1",
    ).run();

    expect(await tone()).toBe("ruthless");
  });
});

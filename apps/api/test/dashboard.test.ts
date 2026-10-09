import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLiveLayer, ReviewRunRepository } from "@not-quite-my-tempo/db";
import type { ReviewResult } from "@not-quite-my-tempo/reviewer";

import app from "../src/index";
import { persistReviewFindings } from "../src/application/review-workflow";
import { resetAndSeedRepository } from "./database";
import { sessionCookie, TEST_SESSION_SECRET } from "./authentication";

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const request = (path: string, cookie?: string) =>
  app.request(
    `https://example.com${path}`,
    cookie === undefined ? undefined : { headers: { cookie } },
    testEnv,
  );

const reviewResult: ReviewResult = {
  provider: "gemini_api",
  review: {
    verdict: "almost",
    summary: "Not quite my tempo.",
    findings: [
      {
        filePath: "src/tempo.ts",
        line: 14,
        severity: "warning",
        category: null,
        confidence: 0.8,
        title: "Off-by-one in beat subdivision",
        message: "Guard subdivision before multiplying.",
      },
    ],
  },
  model: "gemini-3.8-flash",
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
};

const seedRun = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviewRuns = yield* ReviewRunRepository;

      const run = yield* reviewRuns.create({
        repositoryId: 1,
        pullRequestNumber: 42,
        headSha: "dash123",
        trigger: "opened",
      });

      yield* persistReviewFindings(run.id, reviewResult);

      return run;
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

describe("dashboard", () => {
  beforeEach(resetAndSeedRepository);

  it("shows the sign-in landing page without a session", async () => {
    const response = await request("/dashboard");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Sign in with GitHub");
    expect(body).toContain("/auth/login");
  });

  it("asks for consent to the terms beside sign-in", async () => {
    const body = await (await request("/")).text();

    expect(body).toContain("By signing in, you agree to the");
    expect(body).toContain('href="/terms"');
    expect(body).toContain('href="/privacy"');
  });

  it("lets pages post forms with their origin, but keeps OAuth URLs private", async () => {
    // Under "no-referrer" browsers send `Origin: null` on form posts, and
    // the same-origin check then rejects every form, sign-out included.
    const page = await request("/");
    const login = await request("/auth/login");

    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves the privacy policy and terms without a session", async () => {
    const privacy = await request("/privacy");
    const terms = await request("/terms");

    expect(privacy.status).toBe(200);
    expect(terms.status).toBe(200);

    const privacyBody = await privacy.text();
    const termsBody = await terms.text();

    expect(privacyBody).toContain("support@notmytempo.dev");
    expect(termsBody).toContain("Terms of Service");

    // Only Gemini is enabled (ENABLED_VENDORS); name no other AI provider.
    for (const body of [privacyBody, termsBody]) {
      expect(body).not.toMatch(/OpenAI|Anthropic/);
    }
  });

  it("shows the legal pages as signed in when there is a session", async () => {
    const response = await request("/privacy", await sessionCookie([3001]));

    expect(await response.text()).toContain("Sign out");
  });

  it("lists repositories with usage for a signed-in user", async () => {
    await seedRun();

    const response = await request("/dashboard", await sessionCookie([3001]));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("not-my-tempo/app");
    expect(body).toContain("/dashboard/repositories/1");
    expect(body).toContain("Reviews on");
    expect(body).toContain("Pull request 42");
    expect(body).toContain("Reviewing now");
    expect(body).toContain("1,200 model");
  });

  it("summarizes a completed review by its loudest finding", async () => {
    const run = await seedRun();

    await Effect.runPromise(
      ReviewRunRepository.markCompleted(run.id).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
      ),
    );

    const body = await (
      await request("/dashboard", await sessionCookie([3001]))
    ).text();

    expect(body).toContain("1 warning");
    expect(body).toContain('class="dyn dyn-warning"');
  });

  it("explains an empty dashboard with a way to start", async () => {
    const cookie = await sessionCookie([]);

    await env.DB.prepare("DELETE FROM memberships").run();

    const body = await (await request("/dashboard", cookie)).text();

    expect(body).toContain("Install Fletcher on a repository");
    expect(body).toContain('href="/onboarding"');
  });

  it("groups repositories under their workspace with the viewer's role", async () => {
    const body = await (
      await request("/dashboard", await sessionCookie([3001], "member"))
    ).text();

    expect(body).toContain("<h2>not-my-tempo</h2>");
    expect(body).toContain("Member");
    expect(body).toContain('href="/workspaces/1/members"');
  });

  it("shows a workspace whose repositories the user can't see", async () => {
    const body = await (
      await request("/dashboard", await sessionCookie([]))
    ).text();

    expect(body).toContain("<h2>not-my-tempo</h2>");
    expect(body).toContain("None of this account");
  });

  it("shows a repository's runs", async () => {
    await seedRun();

    const response = await request(
      "/dashboard/repositories/1",
      await sessionCookie([3001]),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Pull request 42");
    expect(body).toContain("Reviewing now");
    expect(body).toContain("Opened");
    expect(body).toContain("https://github.com/not-my-tempo/app/pull/42");
    expect(body).toContain('aria-label="Reviews for not-my-tempo/app"');
  });

  it("shows a run's findings", async () => {
    const run = await seedRun();

    const response = await request(
      `/dashboard/runs/${run.id}`,
      await sessionCookie([3001]),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Off-by-one in beat subdivision");
    expect(body).toContain("src/tempo.ts:14");
    expect(body).toContain("warning");
  });

  it("leads a completed review with the stored verdict and summary", async () => {
    const run = await seedRun();

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE review_runs SET status = 'completed' WHERE id = ?",
      ).bind(run.id),
      env.DB.prepare(
        `INSERT INTO findings (review_run_id, file_path, line, severity, message, github_comment_id)
         VALUES (?, 'src/metronome.ts', 3, 'critical', 'Division by zero.', 555)`,
      ).bind(run.id),
    ]);

    const body = await (
      await request(`/dashboard/runs/${run.id}`, await sessionCookie([3001]))
    ).text();

    expect(body).toContain('class="verdict verdict-verdict">Almost.');
    expect(body).toContain("Not quite my tempo.");
    expect(body).toContain("2 findings");
    expect(body.indexOf("src/metronome.ts:3")).toBeLessThan(
      body.indexOf("src/tempo.ts:14"),
    );
    expect(body).toContain(
      "https://github.com/not-my-tempo/app/pull/42#discussion_r555",
    );
  });

  it("infers a verdict for reviews stored before verdicts were saved", async () => {
    const run = await seedRun();

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE review_runs SET status = 'completed', verdict = NULL, summary = NULL WHERE id = ?",
      ).bind(run.id),
      env.DB.prepare(
        "UPDATE findings SET severity = 'critical' WHERE review_run_id = ?",
      ).bind(run.id),
    ]);

    const body = await (
      await request(`/dashboard/runs/${run.id}`, await sessionCookie([3001]))
    ).text();

    expect(body).toContain(
      'class="verdict verdict-failed">Not quite my tempo.',
    );
  });

  it("shows a review in progress without a verdict", async () => {
    const run = await seedRun();

    const body = await (
      await request(`/dashboard/runs/${run.id}`, await sessionCookie([3001]))
    ).text();

    expect(body).toContain("Reviewing now");
    expect(body).not.toContain("Almost.");
  });

  it("does not praise failed or skipped runs without findings", async () => {
    const [failed, skipped] = await Effect.runPromise(
      Effect.gen(function* () {
        const reviewRuns = yield* ReviewRunRepository;

        const failedRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 43,
          headSha: "fail123",
          trigger: "opened",
        });

        yield* reviewRuns.markFailed(failedRun.id, "diff_too_large", "big");

        const skippedRun = yield* reviewRuns.create({
          repositoryId: 1,
          pullRequestNumber: 44,
          headSha: "skip123",
          trigger: "opened",
        });

        yield* reviewRuns.markCompleted(skippedRun.id);

        return [failedRun, skippedRun] as const;
      }).pipe(Effect.provide(makeLiveLayer(env.DB))),
    );

    const cookie = await sessionCookie([3001]);

    const failedBody = await (
      await request(`/dashboard/runs/${failed.id}`, cookie)
    ).text();

    const skippedBody = await (
      await request(`/dashboard/runs/${skipped.id}`, cookie)
    ).text();

    const historyBody = await (
      await request("/dashboard/repositories/1", cookie)
    ).text();

    expect(historyBody).toContain(
      "Failed: the pull request is too large to review",
    );
    expect(historyBody).toContain("Skipped by .fletcher.json");
    expect(historyBody).not.toContain("No findings");
    expect(failedBody).toContain("The review failed");
    expect(failedBody).not.toContain("Good job");
    expect(skippedBody).toContain("Review skipped");
    expect(skippedBody).not.toContain("Good job");
  });

  it("hides inaccessible repositories behind a 404 page", async () => {
    await seedRun();

    const response = await request(
      "/dashboard/repositories/1",
      await sessionCookie([9999]),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(
      "This page doesn&#39;t exist",
    );
  });
});

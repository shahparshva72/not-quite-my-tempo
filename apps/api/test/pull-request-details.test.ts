import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeLiveLayer,
  ReviewRunRepository,
  WorkspaceRepository,
} from "@not-quite-my-tempo/db";

import app from "../src/index";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import {
  sessionCookie,
  testAccess,
  TEST_SESSION_SECRET,
} from "./authentication";
import { resetAndSeedRepository } from "./database";

const secret = "test-webhook-secret";

interface PullRequestEvent {
  readonly action?: string;
  readonly title?: string;
  readonly state?: "open" | "closed";
  readonly mergedAt?: string | null;
  readonly draft?: boolean;
  readonly updatedAt?: string;
  readonly repositoryId?: number;
  readonly authorAssociation?: string;
}

const pullRequestEvent = (event: PullRequestEvent = {}) =>
  JSON.stringify({
    action: event.action ?? "opened",
    installation: { id: 1001 },
    number: 42,
    pull_request: {
      title: event.title ?? "Play Caravan at 240",
      user: { login: "andrew" },
      state: event.state ?? "open",
      merged_at: event.mergedAt ?? null,
      draft: event.draft ?? false,
      head: { sha: "abc123", ref: "double-time" },
      base: { ref: "main" },
      updated_at: event.updatedAt ?? "2026-10-20T10:00:00Z",
      author_association: event.authorAssociation ?? "MEMBER",
    },
    repository: {
      id: event.repositoryId ?? 3001,
      name: "app",
      default_branch: "main",
      owner: { id: 2001, login: "not-my-tempo", type: "Organization" },
    },
  });

const sign = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  return `sha256=${Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const workflowCreate = vi.fn(
  async (options?: WorkflowInstanceCreateOptions<ReviewWorkflowParams>) => ({
    id: options?.id ?? "generated",
  }),
);

const deliver = async (body: string) =>
  app.request(
    "https://example.com/webhooks/github",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": await sign(body),
      },
      body,
    },
    {
      DB: env.DB,
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEW_PULL_REQUEST_WORKFLOW: { create: workflowCreate },
    },
  );

const storedPullRequests = () =>
  env.DB.prepare(
    `SELECT repository_id, number, title, author_login, head_ref, base_ref,
       state, draft FROM pull_requests`,
  )
    .all()
    .then((result) => result.results);

const testEnv = { ...env, SESSION_SECRET: TEST_SESSION_SECRET };

const page = async (path: string) => {
  const cookie = await sessionCookie([3001], "admin");

  const response = await app.request(
    `https://example.com${path}`,
    { headers: { cookie } },
    testEnv,
  );

  return response.text();
};

const seedRun = () =>
  Effect.runPromise(
    ReviewRunRepository.create({
      repositoryId: 1,
      pullRequestNumber: 42,
      // Not the delivered head, whose run the webhook already created.
      headSha: "seed456",
      trigger: "synchronize",
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

describe("pull request details", () => {
  beforeEach(async () => {
    workflowCreate.mockClear();
    await resetAndSeedRepository();
  });

  it("stores a pull request's details when it's opened", async () => {
    const response = await deliver(pullRequestEvent());

    expect(response.status).toBe(202);
    expect(await storedPullRequests()).toEqual([
      {
        repository_id: 1,
        number: 42,
        title: "Play Caravan at 240",
        author_login: "andrew",
        head_ref: "double-time",
        base_ref: "main",
        state: "open",
        draft: 0,
      },
    ]);
  });

  it("keeps details current from actions that don't start reviews", async () => {
    await deliver(pullRequestEvent());

    await deliver(
      pullRequestEvent({
        action: "edited",
        title: "Play Whiplash at 400",
        updatedAt: "2026-10-20T11:00:00Z",
      }),
    );

    expect(await storedPullRequests()).toMatchObject([
      { title: "Play Whiplash at 400", state: "open" },
    ]);

    await deliver(
      pullRequestEvent({
        action: "closed",
        title: "Play Whiplash at 400",
        state: "closed",
        mergedAt: "2026-10-20T12:00:00Z",
        updatedAt: "2026-10-20T12:00:00Z",
      }),
    );

    expect(await storedPullRequests()).toMatchObject([
      { title: "Play Whiplash at 400", state: "merged" },
    ]);
    expect(workflowCreate).toHaveBeenCalledTimes(1);
  });

  it("never lets a late delivery overwrite newer details", async () => {
    await deliver(
      pullRequestEvent({
        action: "closed",
        state: "closed",
        updatedAt: "2026-10-20T12:00:00Z",
      }),
    );

    await deliver(
      pullRequestEvent({
        action: "synchronize",
        updatedAt: "2026-10-20T10:00:00Z",
      }),
    );

    expect(await storedPullRequests()).toMatchObject([{ state: "closed" }]);
  });

  it("stores details for untrusted authors' pull requests too", async () => {
    await deliver(pullRequestEvent({ authorAssociation: "NONE" }));

    expect(await storedPullRequests()).toHaveLength(1);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("stores nothing for repositories Fletcher doesn't know", async () => {
    const response = await deliver(
      pullRequestEvent({ repositoryId: 9999, authorAssociation: "NONE" }),
    );

    expect(response.status).toBe(202);
    expect(await storedPullRequests()).toEqual([]);
  });

  it("deletes pull requests with the workspace's data", async () => {
    await deliver(pullRequestEvent());
    const owner = await testAccess([3001], "owner");

    await Effect.runPromise(
      WorkspaceRepository.deleteDataWithAudit(1, owner.userId).pipe(
        Effect.provide(makeLiveLayer(env.DB)),
      ),
    );

    expect(await storedPullRequests()).toEqual([]);
  });

  it("names the pull request on its review and repository pages", async () => {
    await deliver(pullRequestEvent({ draft: true }));
    const run = await seedRun();

    const review = await page(`/dashboard/runs/${run.id}`);

    expect(review).toContain("Play Caravan at 240");
    expect(review).toContain("Draft");
    expect(review).toContain("by andrew");
    expect(review).toContain("double-time");

    const repository = await page("/dashboard/repositories/1");

    expect(repository).toContain("#42 Play Caravan at 240");

    const dashboard = await page("/dashboard");

    expect(dashboard).toContain("#42 Play Caravan at 240");
  });

  it("falls back to the number before any details arrive", async () => {
    const run = await seedRun();

    const review = await page(`/dashboard/runs/${run.id}`);

    expect(review).toContain("Pull request 42");
    expect(review).not.toContain(`class="review-title"`);
  });

  it("escapes pull request titles", async () => {
    await deliver(pullRequestEvent({ title: "<script>alert(1)</script>" }));
    const run = await seedRun();

    const review = await page(`/dashboard/runs/${run.id}`);

    expect(review).not.toContain("<script>alert(1)</script>");
    expect(review).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

import { env } from "cloudflare:workers";
import { Array as EffectArray, Effect, Option, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import type { ReviewWorkflowParams } from "../src/application/review-requests";
import { decodePullRequestBody } from "../src/github/review-request";
import { verifyGitHubWebhookSignature } from "../src/github/signature";
import { resetAndSeedRepository } from "./database";

const secret = "test-webhook-secret";

const WebhookResponse = Schema.Struct({
  reviewRunId: Schema.Number,
  status: Schema.Literal("queued", "already_processed"),
});

const pullRequestPayload = {
  action: "opened",
  installation: { id: 1001 },
  number: 42,
  pull_request: { head: { sha: "abc123" } },
  repository: {
    id: 3001,
    name: "app",
    default_branch: "main",
    owner: {
      id: 2001,
      login: "not-my-tempo",
      type: "Organization",
    },
  },
};

const sign = async (body: string, signingSecret = secret) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
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

const makeWorkflow = () => {
  const instance = (id: string): WorkflowInstance => ({
    id,
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    delete: async () => undefined,
    status: async () => ({ status: "queued" }),
    sendEvent: async () => undefined,
  });

  const create = vi.fn(
    async (
      options?: WorkflowInstanceCreateOptions<ReviewWorkflowParams>,
    ): Promise<WorkflowInstance> =>
      instance(options?.id ?? "generated-workflow-id"),
  );

  const binding: Workflow<ReviewWorkflowParams> = {
    get: async (id) => instance(id),
    create,
    createBatch: async (batch) =>
      Promise.all(EffectArray.map(batch, (options) => create(options))),
    deleteBatch: async (instanceIds) => ({
      deleted: EffectArray.map(instanceIds, (id) => ({ id })),
      errors: [],
    }),
  };

  return {
    binding,
    create,
  };
};

const webhookRequest = async (
  body: string,
  githubEvent: string,
  workflow: Workflow<ReviewWorkflowParams>,
  signature?: string,
) =>
  app.request(
    "https://example.com/webhooks/github",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": githubEvent,
        "x-hub-signature-256": signature ?? (await sign(body)),
      },
      body,
    },
    {
      DB: env.DB,
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEW_PULL_REQUEST_WORKFLOW: workflow,
    },
  );

describe("GitHub webhook", () => {
  beforeEach(resetAndSeedRepository);

  it("accepts a valid GitHub webhook signature", async () => {
    const body = "Hello, World!";

    const valid = await Effect.runPromise(
      verifyGitHubWebhookSignature(
        new TextEncoder().encode(body).buffer,
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        "It's a Secret to Everybody",
      ),
    );

    expect(valid).toBe(true);
  });

  it("rejects an invalid signature before processing", async () => {
    const workflow = makeWorkflow();

    const response = await webhookRequest(
      JSON.stringify(pullRequestPayload),
      "pull_request",
      workflow.binding,
      await sign(JSON.stringify(pullRequestPayload), "wrong-secret"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_signature" },
    });
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("successfully ignores unsupported GitHub events", async () => {
    const workflow = makeWorkflow();

    const response = await webhookRequest(
      "not parsed for unsupported events",
      "push",
      workflow.binding,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "ignored" });
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("successfully ignores unsupported pull request actions", async () => {
    const workflow = makeWorkflow();
    const body = JSON.stringify({ ...pullRequestPayload, action: "closed" });

    const response = await webhookRequest(
      body,
      "pull_request",
      workflow.binding,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "ignored" });
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("normalizes a pull request payload into the internal request", async () => {
    const result = Option.getOrThrow(
      await Effect.runPromise(
        decodePullRequestBody(
          new TextEncoder().encode(JSON.stringify(pullRequestPayload)).buffer,
        ),
      ),
    );

    expect(result).toEqual({
      installationId: 1001,
      installationAccountId: 2001,
      installationAccountType: "Organization",
      githubRepositoryId: 3001,
      owner: "not-my-tempo",
      repo: "app",
      defaultBranch: "main",
      pullRequestNumber: 42,
      headSha: "abc123",
      trigger: "opened",
    });
  });

  it("creates a queued review run and starts its workflow", async () => {
    const workflow = makeWorkflow();

    const response = await webhookRequest(
      JSON.stringify(pullRequestPayload),
      "pull_request",
      workflow.binding,
    );

    const responseBody = await Effect.runPromise(
      Schema.decodeUnknown(WebhookResponse)(await response.json()),
    );

    const reviewRun = await env.DB.prepare(
      "SELECT * FROM review_runs WHERE id = ?",
    )
      .bind(responseBody.reviewRunId)
      .first<{
        pull_request_number: number;
        head_sha: string;
        status: string;
        trigger: string;
      }>();

    expect(response.status).toBe(202);
    expect(responseBody.status).toBe("queued");
    expect(reviewRun).toMatchObject({
      pull_request_number: 42,
      head_sha: "abc123",
      status: "queued",
      trigger: "opened",
    });
    expect(workflow.create).toHaveBeenCalledWith({
      id: `review-run-${responseBody.reviewRunId}`,
      params: {
        reviewRunId: responseBody.reviewRunId,
        request: expect.objectContaining({
          githubRepositoryId: 3001,
          pullRequestNumber: 42,
          headSha: "abc123",
        }),
      },
    });
  });

  it("creates installation and repository records when necessary", async () => {
    const workflow = makeWorkflow();

    const body = JSON.stringify({
      ...pullRequestPayload,
      installation: { id: 9001 },
      repository: {
        ...pullRequestPayload.repository,
        id: 9002,
        name: "new-repository",
        owner: {
          id: 9003,
          login: "new-owner",
          type: "User",
        },
      },
    });

    const response = await webhookRequest(
      body,
      "pull_request",
      workflow.binding,
    );

    const installation = await env.DB.prepare(
      "SELECT * FROM github_installations WHERE github_installation_id = 9001",
    ).first<{
      github_account_id: number;
      github_account_login: string;
      account_type: string;
    }>();

    const repository = await env.DB.prepare(
      "SELECT * FROM repositories WHERE github_repository_id = 9002",
    ).first<{
      owner: string;
      name: string;
      full_name: string;
      default_branch: string;
    }>();

    expect(response.status).toBe(202);
    expect(installation).toMatchObject({
      github_account_id: 9003,
      github_account_login: "new-owner",
      account_type: "User",
    });
    expect(repository).toMatchObject({
      owner: "new-owner",
      name: "new-repository",
      full_name: "new-owner/new-repository",
      default_branch: "main",
    });
  });

  it("treats a duplicate delivery as successful and idempotent", async () => {
    const workflow = makeWorkflow();
    const body = JSON.stringify(pullRequestPayload);

    const first = await webhookRequest(body, "pull_request", workflow.binding);
    const second = await webhookRequest(body, "pull_request", workflow.binding);

    const count = await env.DB.prepare(
      "SELECT count(*) AS count FROM review_runs",
    ).first<{ count: number }>();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      status: "already_processed",
    });
    expect(count?.count).toBe(1);
    expect(workflow.create).toHaveBeenCalledTimes(1);
  });
});

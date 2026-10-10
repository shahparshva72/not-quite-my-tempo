import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitHubRepositoryRepository,
  makeLiveLayer,
} from "@not-quite-my-tempo/db";
import type { InstallationRepositoryInput } from "@not-quite-my-tempo/db";

import { handleInstallationEvent } from "../src/application/installation-sync";
import {
  handleReviewRequest,
  ReviewWorkflow,
} from "../src/application/review-requests";
import { GitHubAppAuth } from "../src/github/app-auth";
import {
  GitHubInstallationClient,
  GitHubInstallationClientLive,
} from "../src/github/installation-client";
import { decodeInstallationBody } from "../src/github/installation-event";
import type { InstallationEvent } from "../src/github/installation-event";
import { GitHubPullRequestClient } from "../src/github/pull-request-client";
import type { ReviewRequest } from "../src/github/review-request";
import { processGitHubWebhook } from "../src/github/webhook";
import { resetAndSeedRepository } from "./database";

const secret = "test-webhook-secret";

const installationPayload = (action: string) => ({
  action,
  installation: {
    id: 1001,
    account: { id: 2001, login: "not-my-tempo", type: "Organization" },
  },
});

const encode = (payload: ReturnType<typeof installationPayload>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new ArrayBuffer(bytes.byteLength);

  new Uint8Array(buffer).set(bytes);

  return buffer;
};

const sign = async (body: ArrayBuffer) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));

  return `sha256=${Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const event = (effect: InstallationEvent["effect"]): InstallationEvent => ({
  effect,
  installationId: 1001,
  accountId: 2001,
  accountLogin: "not-my-tempo",
  accountType: "Organization",
});

const reviewRequest: ReviewRequest = {
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
};

const stubLayers = (repositories: readonly InstallationRepositoryInput[]) =>
  Layer.mergeAll(
    makeLiveLayer(env.DB),
    Layer.succeed(
      GitHubAppAuth,
      GitHubAppAuth.of({
        mintInstallationToken: () =>
          Effect.succeed({ token: "ghs_sync", expiresAt: new Date() }),
      }),
    ),
    Layer.succeed(
      GitHubInstallationClient,
      GitHubInstallationClient.of({
        listRepositories: () => Effect.succeed(repositories),
      }),
    ),
    Layer.succeed(
      ReviewWorkflow,
      ReviewWorkflow.of({ start: () => Effect.succeed("wf-sync") }),
    ),
  );

const repositoryRow = (githubRepositoryId: number) =>
  env.DB.prepare(
    `SELECT r.removed_at, r.default_branch, i.status
       FROM repositories r
       JOIN github_installations i ON i.id = r.installation_id
      WHERE r.github_repository_id = ?`,
  )
    .bind(githubRepositoryId)
    .first<{
      removed_at: number | null;
      default_branch: string;
      status: string;
    }>();

describe("decodeInstallationBody", () => {
  it("maps installation lifecycle actions to effects", async () => {
    const decode = (
      githubEvent: "installation" | "installation_repositories",
      action: string,
    ) =>
      Effect.runPromise(
        decodeInstallationBody(
          githubEvent,
          encode(installationPayload(action)),
        ),
      ).then((result) => Option.getOrNull(result)?.effect ?? null);

    expect(await decode("installation", "created")).toBe("sync");
    expect(await decode("installation", "unsuspend")).toBe("sync");
    expect(await decode("installation", "suspend")).toBe("suspend");
    expect(await decode("installation", "deleted")).toBe("remove");
    expect(await decode("installation_repositories", "added")).toBe("sync");
    expect(await decode("installation_repositories", "removed")).toBe("sync");
    expect(await decode("installation", "renamed")).toBeNull();
  });
});

describe("handleInstallationEvent", () => {
  beforeEach(resetAndSeedRepository);

  it("reconciles repositories with the list GitHub reports", async () => {
    const result = await Effect.runPromise(
      handleInstallationEvent(event("sync")).pipe(
        Effect.provide(
          stubLayers([
            {
              githubRepositoryId: 3002,
              owner: "not-my-tempo",
              name: "site",
              defaultBranch: "trunk",
            },
          ]),
        ),
      ),
    );

    expect(result).toEqual({ status: "synced", repositoryCount: 1 });
    expect((await repositoryRow(3001))?.removed_at).not.toBeNull();
    expect(await repositoryRow(3002)).toMatchObject({
      removed_at: null,
      default_branch: "trunk",
      status: "active",
    });

    await Effect.runPromise(
      handleInstallationEvent(event("sync")).pipe(
        Effect.provide(
          stubLayers([
            {
              githubRepositoryId: 3001,
              owner: "not-my-tempo",
              name: "app",
              defaultBranch: "main",
            },
          ]),
        ),
      ),
    );

    expect((await repositoryRow(3001))?.removed_at).toBeNull();
    expect((await repositoryRow(3002))?.removed_at).not.toBeNull();
  });

  it("stops reviews for suspended installations until unsuspended", async () => {
    const layers = stubLayers([
      {
        githubRepositoryId: 3001,
        owner: "not-my-tempo",
        name: "app",
        defaultBranch: "main",
      },
    ]);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleInstallationEvent(event("suspend"));
        const whileSuspended = yield* handleReviewRequest(reviewRequest);

        yield* handleInstallationEvent(event("sync"));
        const afterUnsuspend = yield* handleReviewRequest(reviewRequest);

        return { whileSuspended, afterUnsuspend };
      }).pipe(Effect.provide(layers)),
    );

    expect(outcome.whileSuspended).toEqual({ status: "ignored" });
    expect(outcome.afterUnsuspend).toMatchObject({ status: "queued" });
  });

  it("hides removed installations' repositories and skips their reviews", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleInstallationEvent(event("remove"));

        const review = yield* handleReviewRequest(reviewRequest);

        const visible =
          yield* GitHubRepositoryRepository.listByGithubRepositoryIds([3001]);

        return { review, visible };
      }).pipe(Effect.provide(stubLayers([]))),
    );

    expect(outcome.review).toEqual({ status: "ignored" });
    expect(outcome.visible).toEqual([]);
    expect(await repositoryRow(3001)).toMatchObject({ status: "removed" });
  });

  it("skips reviews for repositories disabled in the dashboard", async () => {
    await env.DB.prepare(
      "UPDATE repositories SET enabled = 0 WHERE id = 1",
    ).run();

    const review = await Effect.runPromise(
      handleReviewRequest(reviewRequest).pipe(Effect.provide(stubLayers([]))),
    );

    expect(review).toEqual({ status: "ignored" });
  });
});

describe("installation webhooks", () => {
  beforeEach(resetAndSeedRepository);

  it("routes signed installation deliveries to the sync handler", async () => {
    const body = encode(installationPayload("deleted"));

    const result = await Effect.runPromise(
      processGitHubWebhook(body, await sign(body), "installation", secret).pipe(
        Effect.provide(stubLayers([])),
        Effect.provide(
          Layer.succeed(
            GitHubPullRequestClient,
            GitHubPullRequestClient.of({
              fetchDiff: () => Effect.succeed(""),
              fetchDetails: () => Effect.die("unused"),
              createReview: () => Effect.die("unused"),
              listReviewComments: () => Effect.succeed([]),
              createIssueComment: () => Effect.void,
              createCommentReaction: () => Effect.void,
              fetchRepositoryFile: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    );

    expect(result).toEqual({ status: "removed" });
  });
});

describe("GitHubInstallationClientLive", () => {
  it("follows pagination until a short page", async () => {
    const requestedPages: string[] = [];

    const repository = (id: number) => ({
      id,
      name: `repo-${id}`,
      default_branch: "main",
      owner: { login: "not-my-tempo" },
    });

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      const page = Number(url.searchParams.get("page"));

      requestedPages.push(url.searchParams.get("page") ?? "");

      const repositories =
        page === 1
          ? Array.from({ length: 100 }, (_, index) => repository(index + 1))
          : [repository(101)];

      return new Response(JSON.stringify({ total_count: 101, repositories }));
    };

    const repositories = await Effect.runPromise(
      Effect.flatMap(GitHubInstallationClient, (client) =>
        client.listRepositories("ghs_list"),
      ).pipe(Effect.provide(GitHubInstallationClientLive({ fetchImpl }))),
    );

    expect(requestedPages).toEqual(["1", "2"]);
    expect(repositories).toHaveLength(101);
    expect(repositories[100]).toEqual({
      githubRepositoryId: 101,
      owner: "not-my-tempo",
      name: "repo-101",
      defaultBranch: "main",
    });
  });
});

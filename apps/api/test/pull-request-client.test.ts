import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  GitHubPullRequestClient,
  GitHubPullRequestClientLive,
} from "../src/github/pull-request-client";
import type {
  GitHubPullRequestClientConfig,
  GitHubPullRequestClientService,
} from "../src/github/pull-request-client";

const ref = { owner: "shaffer", repo: "studio-band", pullRequestNumber: 42 };

const withClient = <A, E>(
  config: GitHubPullRequestClientConfig,
  use: (client: GitHubPullRequestClientService) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;

    return yield* use(client);
  }).pipe(Effect.provide(GitHubPullRequestClientLive(config)));

const jsonDetails = {
  title: "Play Caravan at 240",
  body: "Double time swing.",
  base: { ref: "main", sha: "base456" },
  head: { sha: "head789" },
};

describe("GitHubPullRequestClient.fetchDiff", () => {
  it("requests the diff media type with the installation token", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (input, init) => {
      requests.push({ url: String(input), init });

      return Promise.resolve(new Response("diff --git a/x b/x"));
    };

    const diff = await Effect.runPromise(
      withClient({ baseUrl: "https://github.test", fetchImpl }, (client) =>
        client.fetchDiff("ghs_token", ref),
      ),
    );

    expect(diff).toBe("diff --git a/x b/x");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://github.test/repos/shaffer/studio-band/pulls/42",
    );

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github.diff");
    expect(headers.get("authorization")).toBe("Bearer ghs_token");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("fails with a typed error when the diff exceeds the size cap", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("x".repeat(101)));

    const error = await Effect.runPromise(
      Effect.flip(
        withClient({ fetchImpl, maxDiffBytes: 100 }, (client) =>
          client.fetchDiff("ghs_token", ref),
        ),
      ),
    );

    expect(error._tag).toBe("PullRequestDiffTooLargeError");
    expect(error).toMatchObject({ sizeBytes: 101, maxDiffBytes: 100 });
  });

  it("surfaces non-2xx responses with status and body", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("Not Found", { status: 404 }));

    const error = await Effect.runPromise(
      Effect.flip(
        withClient({ fetchImpl }, (client) =>
          client.fetchDiff("ghs_token", ref),
        ),
      ),
    );

    expect(error._tag).toBe("PullRequestResponseError");
    expect(error).toMatchObject({ status: 404, body: "Not Found" });
  });
});

describe("GitHubPullRequestClient.createReview", () => {
  it("posts a COMMENT review with RIGHT-side inline comments", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (input, init) => {
      requests.push({ url: String(input), init });

      return Promise.resolve(new Response(JSON.stringify({ id: 555 })));
    };

    const created = await Effect.runPromise(
      withClient({ baseUrl: "https://github.test", fetchImpl }, (client) =>
        client.createReview("ghs_token", ref, {
          commitId: "head789",
          body: "### \ud83e\udd41 Almost. Almost.",
          comments: [
            { path: "src/tempo.ts", line: 14, body: "Guard the subdivision." },
          ],
        }),
      ),
    );

    expect(created).toEqual({ reviewId: 555 });
    expect(requests[0]?.url).toBe(
      "https://github.test/repos/shaffer/studio-band/pulls/42/reviews",
    );
    expect(requests[0]?.init?.method).toBe("POST");

    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.event).toBe("COMMENT");
    expect(body.commit_id).toBe("head789");
    expect(body.comments).toEqual([
      {
        path: "src/tempo.ts",
        line: 14,
        side: "RIGHT",
        body: "Guard the subdivision.",
      },
    ]);
  });

  it("surfaces non-2xx responses as a review submit error", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("Validation Failed", { status: 422 }));

    const error = await Effect.runPromise(
      Effect.flip(
        withClient({ fetchImpl }, (client) =>
          client.createReview("ghs_token", ref, {
            commitId: "head789",
            body: "summary",
            comments: [],
          }),
        ),
      ),
    );

    expect(error._tag).toBe("ReviewSubmitResponseError");
    expect(error).toMatchObject({ status: 422 });
  });
});

describe("GitHubPullRequestClient.listReviewComments", () => {
  it("decodes posted review comments", async () => {
    const requests: { url: string }[] = [];

    const fetchImpl: typeof fetch = (input) => {
      requests.push({ url: String(input) });

      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 9001, path: "src/tempo.ts", line: 14, body: "Guard it." },
            { id: 9002, path: "src/cymbal.ts", body: "File-level." },
          ]),
        ),
      );
    };

    const comments = await Effect.runPromise(
      withClient({ baseUrl: "https://github.test", fetchImpl }, (client) =>
        client.listReviewComments("ghs_token", ref, 555),
      ),
    );

    expect(requests[0]?.url).toBe(
      "https://github.test/repos/shaffer/studio-band/pulls/42/reviews/555/comments",
    );
    expect(comments).toEqual([
      { id: 9001, path: "src/tempo.ts", line: 14, body: "Guard it." },
      { id: 9002, path: "src/cymbal.ts", line: null, body: "File-level." },
    ]);
  });
});

describe("GitHubPullRequestClient.fetchDetails", () => {
  it("decodes pull request metadata into details", async () => {
    const requests: { init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (_input, init) => {
      requests.push({ init });

      return Promise.resolve(new Response(JSON.stringify(jsonDetails)));
    };

    const details = await Effect.runPromise(
      withClient({ fetchImpl }, (client) =>
        client.fetchDetails("ghs_token", ref),
      ),
    );

    expect(details).toEqual({
      title: "Play Caravan at 240",
      body: "Double time swing.",
      baseRef: "main",
      baseSha: "base456",
      headSha: "head789",
    });

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
  });

  it("fails when the metadata response does not match the schema", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ nonsense: true })));

    const error = await Effect.runPromise(
      Effect.flip(
        withClient({ fetchImpl }, (client) =>
          client.fetchDetails("ghs_token", ref),
        ),
      ),
    );

    expect(error._tag).toBe("PullRequestRequestError");
  });
});

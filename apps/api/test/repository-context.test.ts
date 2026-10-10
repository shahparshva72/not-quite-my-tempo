import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { fetchRepositoryContext } from "../src/application/repository-context";
import {
  GitHubPullRequestClient,
  PullRequestResponseError,
} from "../src/github/pull-request-client";
import type { RepositoryContextInput } from "../src/application/repository-context";
import type { RepositoryTreeEntry } from "../src/github/pull-request-client";

const modifiedFile = (path: string, addedLines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${addedLines + 1} @@`,
    " const before = 1;",
    ...Array.from(
      { length: addedLines },
      (_, index) => `+const n${index} = 1;`,
    ),
    "",
  ].join("\n");

const newFile = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    "+export const fresh = 1;",
    "",
  ].join("\n");

const baseInput: RepositoryContextInput = {
  installationToken: "ghs_token",
  ref: { owner: "shaffer", repo: "studio-band", pullRequestNumber: 42 },
  defaultBranch: "main",
  headSha: "head789",
  diff: modifiedFile("apps/api/src/tempo.ts", 2),
  guidelines: null,
};

interface FakeRepository {
  readonly tree: readonly RepositoryTreeEntry[];
  /** Content by `${gitRef}:${path}`. */
  readonly files: Readonly<Record<string, string>>;
  readonly failingPaths?: readonly string[];
}

const fakeClient = (repository: FakeRepository, reads: string[] = []) =>
  Layer.succeed(
    GitHubPullRequestClient,
    GitHubPullRequestClient.of({
      fetchDiff: () => Effect.succeed(""),
      fetchDetails: () =>
        Effect.succeed({
          title: "",
          body: null,
          baseRef: "main",
          baseSha: "base",
          headSha: "head789",
        }),
      createReview: () => Effect.succeed({ reviewId: 1 }),
      listReviewComments: () => Effect.succeed([]),
      createIssueComment: () => Effect.void,
      createCommentReaction: () => Effect.void,
      fetchRepositoryFile: (_token, _ref, path, gitRef) => {
        reads.push(`${gitRef}:${path}`);

        if (repository.failingPaths?.includes(path) === true) {
          return Effect.fail(
            new PullRequestResponseError({ status: 500, body: "boom" }),
          );
        }

        return Effect.succeed(
          Option.fromNullable(repository.files[`${gitRef}:${path}`]),
        );
      },
      fetchTree: () => Effect.succeed(repository.tree),
    }),
  );

const blob = (path: string, sizeBytes = 100): RepositoryTreeEntry => ({
  path,
  sizeBytes,
});

const run = (repository: FakeRepository, input = baseInput) =>
  Effect.runPromise(
    fetchRepositoryContext(input).pipe(Effect.provide(fakeClient(repository))),
  );

describe("fetchRepositoryContext", () => {
  it("reads guidelines from the default branch and code from the head", async () => {
    const reads: string[] = [];

    const context = await Effect.runPromise(
      fetchRepositoryContext(baseInput).pipe(
        Effect.provide(
          fakeClient(
            {
              tree: [
                blob("AGENTS.md"),
                blob("apps/api/AGENTS.md"),
                blob("package.json"),
                blob("apps/api/package.json"),
                blob("apps/api/src/tempo.ts"),
              ],
              files: {
                "main:AGENTS.md": "Root rules.",
                "main:apps/api/AGENTS.md": "API rules.",
                "head789:package.json": "{}",
                "head789:apps/api/package.json": '{"name":"api"}',
                "head789:apps/api/src/tempo.ts": "const before = 1;",
              },
            },
            reads,
          ),
        ),
      ),
    );

    expect(context?.guidelinesRef).toBe("main");
    expect(context?.guidelines.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "apps/api/AGENTS.md",
    ]);
    expect(context?.manifests.map((file) => file.path)).toEqual([
      "package.json",
      "apps/api/package.json",
    ]);
    expect(context?.files).toEqual([
      {
        path: "apps/api/src/tempo.ts",
        content: "const before = 1;",
        truncated: false,
      },
    ]);
    expect(reads).not.toContain("head789:AGENTS.md");
  });

  it("uses only the configured guideline globs when set", async () => {
    const context = await run(
      {
        tree: [
          blob("AGENTS.md"),
          blob("docs/style/naming.md"),
          blob("docs/README.md"),
        ],
        files: {
          "main:AGENTS.md": "Root rules.",
          "main:docs/style/naming.md": "Name things well.",
        },
      },
      { ...baseInput, guidelines: ["docs/style/**"] },
    );

    expect(context?.guidelines.map((file) => file.path)).toEqual([
      "docs/style/naming.md",
    ]);
  });

  it("skips new files and omits files over budget, most-changed first", async () => {
    const context = await run(
      {
        tree: [
          blob("src/small.ts", 100),
          blob("src/busy.ts", 100),
          blob("src/huge.ts", 70_000),
          blob("src/fresh.ts", 30),
        ],
        files: {
          "head789:src/small.ts": "small",
          "head789:src/busy.ts": "busy",
        },
      },
      {
        ...baseInput,
        diff:
          modifiedFile("src/small.ts", 1) +
          modifiedFile("src/busy.ts", 5) +
          modifiedFile("src/huge.ts", 9) +
          newFile("src/fresh.ts"),
      },
    );

    expect(context?.files.map((file) => file.path)).toEqual([
      "src/busy.ts",
      "src/small.ts",
    ]);
    expect(context?.omittedFiles).toEqual(["src/huge.ts"]);
  });

  it("truncates guidelines past the budget", async () => {
    const context = await run({
      tree: [blob("AGENTS.md"), blob("CLAUDE.md")],
      files: {
        "main:AGENTS.md": "a".repeat(39_990),
        "main:CLAUDE.md": "b".repeat(100),
      },
    });

    expect(context?.guidelines[1]).toEqual({
      path: "CLAUDE.md",
      content: "b".repeat(10),
      truncated: true,
    });
  });

  it("leaves out files GitHub fails to return", async () => {
    const context = await run({
      tree: [blob("AGENTS.md"), blob("apps/api/src/tempo.ts")],
      files: { "main:AGENTS.md": "Root rules." },
      failingPaths: ["apps/api/src/tempo.ts"],
    });

    expect(context?.guidelines).toHaveLength(1);
    expect(context?.files).toEqual([]);
    expect(context?.omittedFiles).toEqual(["apps/api/src/tempo.ts"]);
  });

  it("returns null when the tree can't be listed", async () => {
    const context = await Effect.runPromise(
      fetchRepositoryContext(baseInput).pipe(
        Effect.provide(
          Layer.succeed(
            GitHubPullRequestClient,
            GitHubPullRequestClient.of({
              fetchDiff: () => Effect.succeed(""),
              fetchDetails: () => Effect.die("unused"),
              createReview: () => Effect.succeed({ reviewId: 1 }),
              listReviewComments: () => Effect.succeed([]),
              createIssueComment: () => Effect.void,
              createCommentReaction: () => Effect.void,
              fetchRepositoryFile: () => Effect.succeed(Option.none()),
              fetchTree: () =>
                Effect.fail(
                  new PullRequestResponseError({ status: 409, body: "empty" }),
                ),
            }),
          ),
        ),
      ),
    );

    expect(context).toBeNull();
  });
});

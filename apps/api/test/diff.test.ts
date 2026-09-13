import { describe, expect, it } from "vitest";
import {
  filterUnifiedDiff,
  isIgnoredDiffPath,
  parseUnifiedDiff,
  reviewableDiffFiles,
} from "@not-quite-my-tempo/core";

import pullRequestDiff from "./fixtures/pull-request.diff?raw";

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(pullRequestDiff);

  it("parses every file in the fixture with its status", () => {
    expect(
      files.map((file) => ({ path: file.path, status: file.status })),
    ).toEqual([
      { path: "src/tempo.ts", status: "modified" },
      { path: "src/cymbal.ts", status: "added" },
      { path: "src/folder.ts", status: "removed" },
      { path: "src/charts/caravan.ts", status: "renamed" },
      { path: "pnpm-lock.yaml", status: "modified" },
    ]);
  });

  it("tracks the previous path for renames only", () => {
    expect(files.map((file) => file.previousPath)).toEqual([
      null,
      null,
      null,
      "src/chart.ts",
      null,
    ]);
  });

  it("parses hunk headers and boundaries", () => {
    const modified = files[0];

    expect(modified?.hunks).toHaveLength(2);
    expect(modified?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 6,
      newStart: 1,
      newLines: 7,
      header: "export const tempo = () => {",
    });
    expect(modified?.hunks[1]).toMatchObject({ oldStart: 12, newStart: 13 });
  });

  it("assigns new-file line numbers to added lines for comment anchoring", () => {
    const secondHunk = files[0]?.hunks[1];

    expect(secondHunk?.lines).toEqual([
      {
        kind: "context",
        content: "export const swing = () => {",
        oldLine: 12,
        newLine: 13,
      },
      {
        kind: "removed",
        content: '  return "dragging";',
        oldLine: 13,
        newLine: null,
      },
      {
        kind: "added",
        content: '  return "on the beat";',
        oldLine: null,
        newLine: 14,
      },
      { kind: "context", content: "};", oldLine: 14, newLine: 15 },
      {
        kind: "added",
        content: 'export const rush = () => "rushing";',
        oldLine: null,
        newLine: 16,
      },
    ]);
  });

  it("numbers added lines in a new file from one", () => {
    const added = files[1];
    const lines = added?.hunks[0]?.lines ?? [];

    expect(lines.map((line) => line.newLine)).toEqual([1, 2, 3]);
    expect(lines.every((line) => line.kind === "added")).toBe(true);
  });

  it("skips no-newline markers without breaking line numbering", () => {
    const lockfile = files[4];
    const lines = lockfile?.hunks[0]?.lines ?? [];

    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatchObject({ kind: "context", newLine: 3 });
  });

  it("returns no files for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("reviewableDiffFiles", () => {
  it("filters generated and lock files out of the fixture", () => {
    const reviewable = reviewableDiffFiles(parseUnifiedDiff(pullRequestDiff));

    expect(reviewable.map((file) => file.path)).toEqual([
      "src/tempo.ts",
      "src/cymbal.ts",
      "src/folder.ts",
      "src/charts/caravan.ts",
    ]);
  });

  it("filters ignored file blocks out of the raw diff text", () => {
    const filtered = filterUnifiedDiff(pullRequestDiff);

    expect(filtered).not.toContain("pnpm-lock.yaml");
    expect(filtered).toContain("diff --git a/src/tempo.ts b/src/tempo.ts");
    expect(parseUnifiedDiff(filtered).map((file) => file.path)).toEqual([
      "src/tempo.ts",
      "src/cymbal.ts",
      "src/folder.ts",
      "src/charts/caravan.ts",
    ]);
  });

  it("ignores known generated paths anywhere in the tree", () => {
    expect(isIgnoredDiffPath("pnpm-lock.yaml")).toBe(true);
    expect(isIgnoredDiffPath("packages/db/drizzle/0000_init.sql")).toBe(true);
    expect(isIgnoredDiffPath("packages/db/drizzle/meta/_journal.json")).toBe(
      true,
    );
    expect(isIgnoredDiffPath("apps/api/worker-configuration.d.ts")).toBe(true);
    expect(isIgnoredDiffPath("dist/app.min.js")).toBe(true);
    expect(isIgnoredDiffPath("assets/logo.png")).toBe(true);
    expect(isIgnoredDiffPath("src/locks.ts")).toBe(false);
    expect(isIgnoredDiffPath("src/minify.js")).toBe(false);
  });
});

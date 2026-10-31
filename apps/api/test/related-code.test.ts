import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@not-quite-my-tempo/core";
import { buildReviewUserPrompt } from "@not-quite-my-tempo/reviewer";
import type { GeminiReviewInput } from "@not-quite-my-tempo/reviewer";

import {
  changedSymbols,
  findRelatedCode,
  isTestPath,
  testsForChanges,
} from "../src/application/related-code.js";
import type { CodeSearch } from "../src/application/related-code.js";

const diff = `diff --git a/src/tempo.ts b/src/tempo.ts
--- a/src/tempo.ts
+++ b/src/tempo.ts
@@ -10,3 +10,4 @@ export function countOff(beats: number) {
   const bar = beats * 4;
-  return bar;
+  if (bar === 0) throw new Error("no tempo");
+  return bar;
@@ -30,2 +31,3 @@
+export const parseTempo = (text: string) => Number(text);
 const unchanged = 1;
`;

const lines = (count: number, at: Record<number, string>) =>
  Array.from(
    { length: count },
    (_, index) => at[index + 1] ?? `line ${index + 1}`,
  ).join("\n");

const files = new Map([
  ["src/tempo.ts", lines(40, {})],
  ["src/band.ts", lines(60, { 20: "countOff(8)", 50: "parseTempo(raw)" })],
  ["src/drums.ts", lines(30, { 5: "parseTempo(input)" })],
  ["test/tempo.test.ts", lines(200, {})],
  ["test/unrelated.test.ts", lines(10, {})],
]);

const fakeSearch = (
  hits: Record<string, readonly { path: string; line: number }[]>,
): CodeSearch => ({
  listFiles: Effect.succeed([...files.keys()]),
  findWord: (word, limit) => Effect.succeed((hits[word] ?? []).slice(0, limit)),
  readFile: (path) => Effect.succeed(Option.fromNullable(files.get(path))),
});

describe("changedSymbols", () => {
  it("names definitions on changed lines, then the functions hunks sit in", () => {
    expect(changedSymbols(parseUnifiedDiff(diff))).toEqual([
      "parseTempo",
      "countOff",
    ]);
  });

  it("doesn't mistake control flow for a definition", () => {
    const controlFlow = `diff --git a/src/tempo.ts b/src/tempo.ts
--- a/src/tempo.ts
+++ b/src/tempo.ts
@@ -1,1 +1,7 @@
+  while (ready) {
+  switch (beat) {
+  catch (error) {
+  foreach ($beats as $beat) {
+  synchronized (lock) {
+  subdivide(beat: number): number {
`;

    expect(changedSymbols(parseUnifiedDiff(controlFlow))).toEqual([
      "subdivide",
    ]);
  });
});

describe("test discovery", () => {
  it("recognises the usual test file conventions", () => {
    for (const path of [
      "test/tempo.ts",
      "src/tempo.test.ts",
      "pkg/tempo_test.go",
      "src/test/java/TempoTest.java",
      "tests/test_tempo.py",
      "spec/tempo_spec.rb",
    ]) {
      expect(isTestPath(path)).toBe(true);
    }

    expect(isTestPath("src/tempo.ts")).toBe(false);
  });

  it("finds tests named after changed source files", () => {
    expect(testsForChanges(["src/tempo.ts"], [...files.keys()])).toEqual([
      "test/tempo.test.ts",
    ]);
  });
});

describe("findRelatedCode", () => {
  const run = (
    hits: Record<string, readonly { path: string; line: number }[]>,
    shown: readonly string[] = ["src/tempo.ts"],
  ) => Effect.runPromise(findRelatedCode(fakeSearch(hits), diff, shown));

  it("returns tests first, then callers around each hit", async () => {
    const related = await run({
      parseTempo: [
        { path: "src/tempo.ts", line: 31 },
        { path: "src/band.ts", line: 50 },
        { path: "src/drums.ts", line: 5 },
      ],
      countOff: [{ path: "src/band.ts", line: 20 }],
    });

    expect(
      related.map((snippet) => [
        snippet.path,
        snippet.startLine,
        snippet.endLine,
        snippet.reason,
      ]),
    ).toEqual([
      ["test/tempo.test.ts", 1, 150, "tests a changed file"],
      ["src/band.ts", 44, 56, "references parseTempo"],
      ["src/drums.ts", 1, 11, "references parseTempo"],
      ["src/band.ts", 14, 26, "references countOff"],
    ]);
    expect(related[1]?.content.split("\n")).toHaveLength(13);
  });

  it("skips names found too widely to mean anything", async () => {
    const everywhere = Array.from({ length: 40 }, (_, index) => ({
      path: "src/band.ts",
      line: index + 1,
    }));

    const related = await run({ parseTempo: everywhere });

    expect(related.map((snippet) => snippet.reason)).toEqual([
      "tests a changed file",
    ]);
  });

  it("searches changed files the prompt does not show in full", async () => {
    const related = await run(
      { countOff: [{ path: "src/band.ts", line: 20 }] },
      [],
    );

    expect(related.map((snippet) => snippet.path)).toContain("src/band.ts");
  });

  it("shows lines found by two symbols once", async () => {
    const related = await run({
      parseTempo: [{ path: "src/band.ts", line: 20 }],
      countOff: [{ path: "src/band.ts", line: 21 }],
    });

    expect(
      related.filter((snippet) => snippet.path === "src/band.ts"),
    ).toHaveLength(2);

    const again = await run({
      parseTempo: [{ path: "src/band.ts", line: 20 }],
      countOff: [{ path: "src/band.ts", line: 20 }],
    });

    expect(
      again.filter((snippet) => snippet.path === "src/band.ts"),
    ).toHaveLength(1);
  });
});

describe("related code in the review prompt", () => {
  const input: GeminiReviewInput = {
    repository: "shaffer/studio-band",
    pullRequestNumber: 42,
    title: "Play Caravan at 240",
    body: null,
    diff,
    priorReview: null,
    context: {
      guidelinesRef: "main",
      guidelines: [],
      manifests: [],
      files: [],
      omittedFiles: [],
      related: [
        {
          path: "src/band.ts",
          startLine: 14,
          endLine: 26,
          reason: "references countOff",
          content: "countOff(8)",
        },
      ],
    },
    intensity: "studio_band",
    tone: "standard",
  };

  it("shows each snippet with its place and why it was picked", () => {
    expect(buildReviewUserPrompt(input)).toContain(
      '<related path="src/band.ts" lines="14-26" reason="references countOff">\ncountOff(8)\n</related>',
    );
  });

  it("adds nothing when there is no related code", () => {
    const prompt = buildReviewUserPrompt({
      ...input,
      context: { ...input.context!, related: [] },
    });

    expect(prompt).not.toContain("Related code elsewhere");
  });
});

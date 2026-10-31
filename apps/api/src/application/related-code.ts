import { Effect, Option } from "effect";
import { parseUnifiedDiff } from "@not-quite-my-tempo/core";
import type { DiffFile } from "@not-quite-my-tempo/core";
import type { RelatedSnippet } from "@not-quite-my-tempo/reviewer";

/**
 * Searching a checkout of the pull request's head: a local clone, a
 * sandbox, or a benchmark's container. GitHub's API can't search a branch,
 * so production has none of this yet.
 */
export interface CodeSearch {
  /** Every tracked file path. */
  readonly listFiles: Effect.Effect<readonly string[]>;
  /** Lines that contain `word` as a whole word, at most `limit`. */
  readonly findWord: (
    word: string,
    limit: number,
  ) => Effect.Effect<readonly CodeHit[]>;
  readonly readFile: (path: string) => Effect.Effect<Option.Option<string>>;
}

export interface CodeHit {
  readonly path: string;
  readonly line: number;
}

// About a tenth of a large review prompt, split so neither tests nor
// callers crowd the other out.
const TESTS_MAX_BYTES = 20_000;

const CALLERS_MAX_BYTES = 20_000;

const MAX_SYMBOLS = 10;

// A name found in more places than this is too common to say anything.
const MAX_HITS_PER_SYMBOL = 30;

const MAX_FILES_PER_SYMBOL = 4;

const CALLER_CONTEXT_LINES = 6;

const MAX_TEST_FILES = 3;

const TEST_MAX_LINES = 150;

// Definitions across the languages benchmarks and customers use. Each
// captures the defined name in its first group.
const DEFINITION_PATTERNS = [
  /\b(?:function|def|fn|func|class|interface|struct|enum|trait|type|module|object)\s+(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_][\w]*[?!]?)/,
  /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>[\],.| ]+)?\s*\{\s*$/,
];

// Names that match everywhere and point at nothing in particular.
const COMMON_NAMES = new Set([
  "constructor",
  "init",
  "main",
  "setup",
  "test",
  "render",
  "value",
  "data",
  "name",
  "index",
  "handle",
  "handler",
  "update",
  "create",
  "delete",
  "get",
  "set",
  "run",
  "start",
  "stop",
  "close",
  "open",
  "toString",
  "equals",
  "hashCode",
  "default",
  "props",
  "state",
  "self",
  "this",
  "return",
  "string",
  "number",
  "boolean",
  "object",
  // Control flow reads like a method definition: `while (ready) {`.
  "while",
  "switch",
  "catch",
  "foreach",
  "elseif",
  "synchronized",
  "using",
  "when",
]);

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|testing)\/|([._-](test|spec)s?|Tests?|_test|IT)\.[A-Za-z]+$|(^|\/)test_[^/]+\.py$/;

export const isTestPath = (path: string) => TEST_PATH.test(path);

const definedName = (line: string) => {
  for (const pattern of DEFINITION_PATTERNS) {
    const name = pattern.exec(line)?.[1];

    if (name !== undefined) {
      return name;
    }
  }

  return undefined;
};

/**
 * Names the change defines, redefines, or edits inside: definitions on
 * added or removed lines first, then the functions hunks sit in.
 */
export const changedSymbols = (files: readonly DiffFile[]) => {
  const touched = files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== "context")
        .map((line) => definedName(line.content)),
    ),
  );

  const enclosing = files.flatMap((file) =>
    file.hunks.map((hunk) => definedName(hunk.header)),
  );

  return [
    ...new Set(
      [...touched, ...enclosing].filter(
        (name): name is string =>
          name !== undefined &&
          name.length >= 4 &&
          !COMMON_NAMES.has(name) &&
          !COMMON_NAMES.has(name.toLowerCase()),
      ),
    ),
  ].slice(0, MAX_SYMBOLS);
};

const stem = (path: string) =>
  (path.split("/").at(-1) ?? path)
    .replace(/\.[^.]+$/, "")
    .replace(/([._-](test|spec)s?|Tests?|_test|IT)$/, "")
    .replace(/^test_/, "")
    .toLowerCase();

/** Test files named after a changed source file, the closest first. */
export const testsForChanges = (
  changedPaths: readonly string[],
  allPaths: readonly string[],
) => {
  const changed = new Set(changedPaths);

  const stems = new Set(
    changedPaths.flatMap((path) => {
      const name = stem(path);

      return isTestPath(path) || name.length < 3 ? [] : [name];
    }),
  );

  return allPaths.filter(
    (path) => !changed.has(path) && isTestPath(path) && stems.has(stem(path)),
  );
};

const lineRange = (content: string, start: number, end: number) =>
  content
    .split("\n")
    .slice(start - 1, end)
    .join("\n");

const encoder = new TextEncoder();

/** Keeps snippets in order while they fit, skipping any that don't. */
const fitToBudget = (snippets: readonly RelatedSnippet[], maxBytes: number) => {
  const fitted: RelatedSnippet[] = [];

  let remaining = maxBytes;

  for (const snippet of snippets) {
    const size = encoder.encode(snippet.content).byteLength;

    if (size <= remaining) {
      fitted.push(snippet);
      remaining -= size;
    }
  }

  return fitted;
};

/** Merges hits in one file into the line ranges around them. */
const rangesAround = (lines: readonly number[]) =>
  [...lines]
    .sort((a, b) => a - b)
    .reduce<{ start: number; end: number }[]>((ranges, line) => {
      const start = Math.max(1, line - CALLER_CONTEXT_LINES);
      const end = line + CALLER_CONTEXT_LINES;
      const last = ranges.at(-1);

      if (last !== undefined && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }

      return ranges;
    }, []);

/**
 * Callers of the changed symbols, and the tests of the changed files,
 * within a byte budget. Files the prompt already shows in full (`shown`)
 * are skipped; a changed file left out for size is searched like any other.
 */
export const findRelatedCode = (
  search: CodeSearch,
  diff: string,
  shown: readonly string[],
) =>
  Effect.gen(function* () {
    const files = parseUnifiedDiff(diff).filter(
      (file) => file.status !== "removed",
    );

    const changedPaths = files.map((file) => file.path);

    const inPrompt = new Set(shown);

    const allPaths = yield* search.listFiles;

    const tests = testsForChanges(changedPaths, allPaths).slice(
      0,
      MAX_TEST_FILES,
    );

    const testSnippets = yield* Effect.forEach(tests, (path) =>
      search.readFile(path).pipe(
        Effect.map(
          Option.map((content): RelatedSnippet => {
            const lineCount = content.split("\n").length;
            const endLine = Math.min(lineCount, TEST_MAX_LINES);

            return {
              path,
              startLine: 1,
              endLine,
              reason: "tests a changed file",
              content: lineRange(content, 1, endLine),
            };
          }),
        ),
      ),
    );

    const shownTests = new Set(tests);

    const callerSnippets = yield* Effect.forEach(
      changedSymbols(files),
      (symbol) =>
        Effect.gen(function* () {
          const hits = yield* search.findWord(symbol, MAX_HITS_PER_SYMBOL + 1);

          if (hits.length > MAX_HITS_PER_SYMBOL) {
            return [];
          }

          const byFile = new Map<string, number[]>();

          for (const hit of hits) {
            if (!inPrompt.has(hit.path) && !shownTests.has(hit.path)) {
              byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit.line]);
            }
          }

          const picked = [...byFile].slice(0, MAX_FILES_PER_SYMBOL);

          const snippets = yield* Effect.forEach(picked, ([path, lines]) =>
            search.readFile(path).pipe(
              Effect.map((content) =>
                Option.match(content, {
                  onNone: () => [],
                  onSome: (text) =>
                    rangesAround(lines).map(
                      ({ start, end }): RelatedSnippet => ({
                        path,
                        startLine: start,
                        endLine: Math.min(end, text.split("\n").length),
                        reason: `references ${symbol}`,
                        content: lineRange(text, start, end),
                      }),
                    ),
                }),
              ),
            ),
          );

          return snippets.flat();
        }),
    );

    // Two symbols used side by side find the same lines; show them once.
    const covered = (snippet: RelatedSnippet, earlier: RelatedSnippet) =>
      earlier.path === snippet.path &&
      earlier.startLine <= snippet.startLine &&
      earlier.endLine >= snippet.endLine;

    const callers = callerSnippets
      .flat()
      .filter(
        (snippet, index, all) =>
          !all.slice(0, index).some((earlier) => covered(snippet, earlier)),
      );

    return [
      ...fitToBudget(testSnippets.flatMap(Option.toArray), TESTS_MAX_BYTES),
      ...fitToBudget(callers, CALLERS_MAX_BYTES),
    ];
  });

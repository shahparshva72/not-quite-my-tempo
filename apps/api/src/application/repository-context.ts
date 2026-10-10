import { Effect, Option } from "effect";
import { globToRegExp, parseUnifiedDiff } from "@not-quite-my-tempo/core";
import type {
  ContextFile,
  RepositoryContext,
} from "@not-quite-my-tempo/reviewer";

import { GitHubPullRequestClient } from "../github/pull-request-client.js";
import type {
  PullRequestRef,
  RepositoryTreeEntry,
} from "../github/pull-request-client.js";
import { logError } from "../logging.js";

/** Where repositories usually keep instructions for reviewers and agents. */
const DEFAULT_GUIDELINE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  ".github/copilot-instructions.md",
];

/** Instruction files that also apply to the directory they sit in. */
const SCOPED_GUIDELINE_NAMES = ["AGENTS.md", "CLAUDE.md"];

const MANIFEST_NAMES = new Set([
  "package.json",
  "deno.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

// Budgets keep the prompt (and this step's persisted output) bounded on
// top of a diff of up to 300 KB. Credits are still charged on the diff
// alone, so these also cap what the extra context costs per review.
const GUIDELINES_MAX_BYTES = 40_000;

const MAX_GUIDELINE_FILES = 8;

const MANIFEST_MAX_BYTES = 10_000;

const MAX_MANIFESTS = 6;

const FILES_MAX_BYTES = 150_000;

const FILE_MAX_BYTES = 60_000;

const MAX_FILES = 25;

const FETCH_CONCURRENCY = 6;

export interface RepositoryContextInput {
  readonly installationToken: string;
  readonly ref: PullRequestRef;
  readonly defaultBranch: string;
  readonly headSha: string;
  /** The pull request's diff after ignore globs were applied. */
  readonly diff: string;
  /** `.fletcher.json` `guidelines`; null for the usual locations. */
  readonly guidelines: readonly string[] | null;
}

const encoder = new TextEncoder();

const byteLength = (text: string) => encoder.encode(text).byteLength;

const truncateToBytes = (text: string, maxBytes: number) =>
  new TextDecoder().decode(encoder.encode(text).slice(0, maxBytes));

/** Every directory above a path, nearest first; "" is the root. */
const ancestorDirectories = (path: string): readonly string[] => {
  const segments = path.split("/").slice(0, -1);

  return Array.from({ length: segments.length + 1 }, (_, index) =>
    segments.slice(0, segments.length - index).join("/"),
  );
};

const joinPath = (directory: string, name: string) =>
  directory === "" ? name : `${directory}/${name}`;

const unique = (paths: readonly string[]) => [...new Set(paths)];

const guidelinePaths = (
  configured: readonly string[] | null,
  blobPaths: readonly string[],
  changedPaths: readonly string[],
): readonly string[] => {
  const existing = new Set(blobPaths);

  if (configured !== null) {
    const patterns = configured.map(globToRegExp);

    return blobPaths.filter((path) =>
      patterns.some((pattern) => pattern.test(path)),
    );
  }

  // Nested instructions apply to changes beneath them; the shallowest come
  // first so repository-wide rules lead.
  const scoped = changedPaths
    .flatMap(ancestorDirectories)
    .filter((directory) => directory !== "")
    .flatMap((directory) =>
      SCOPED_GUIDELINE_NAMES.map((name) => joinPath(directory, name)),
    )
    .filter((path) => existing.has(path))
    .sort((a, b) => a.split("/").length - b.split("/").length);

  return unique([
    ...DEFAULT_GUIDELINE_PATHS.filter((path) => existing.has(path)),
    ...scoped,
  ]);
};

/** The root manifests, then the nearest manifests of each changed file. */
const manifestPaths = (
  blobPaths: readonly string[],
  changedPaths: readonly string[],
): readonly string[] => {
  const manifestsByDirectory = new Map<string, string[]>();

  for (const path of blobPaths) {
    const name = path.split("/").at(-1) ?? path;

    if (MANIFEST_NAMES.has(name)) {
      const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
      const manifests = manifestsByDirectory.get(directory) ?? [];

      manifests.push(path);
      manifestsByDirectory.set(directory, manifests);
    }
  }

  const nearest = changedPaths.flatMap(
    (path) =>
      ancestorDirectories(path)
        .map((directory) => manifestsByDirectory.get(directory))
        .find((manifests) => manifests !== undefined) ?? [],
  );

  return unique([...(manifestsByDirectory.get("") ?? []), ...nearest]).slice(
    0,
    MAX_MANIFESTS,
  );
};

interface ChangedFile {
  readonly path: string;
  readonly addedLines: number;
}

/**
 * Picks the changed files to show in full: the most-changed first, each
 * small enough to fit, until the budget runs out. New files are left out
 * because the diff already holds all of them.
 */
const selectFiles = (
  changed: readonly ChangedFile[],
  sizes: ReadonlyMap<string, number>,
) => {
  const selected: string[] = [];
  const omitted: string[] = [];
  let totalBytes = 0;

  for (const file of [...changed].sort((a, b) => b.addedLines - a.addedLines)) {
    const size = sizes.get(file.path);

    if (
      size !== undefined &&
      size <= FILE_MAX_BYTES &&
      totalBytes + size <= FILES_MAX_BYTES &&
      selected.length < MAX_FILES
    ) {
      selected.push(file.path);
      totalBytes += size;
    } else {
      omitted.push(file.path);
    }
  }

  return { selected, omitted };
};

/** Keeps files in order until `maxBytes`, cutting the one that crosses it. */
const fitToBudget = (files: readonly ContextFile[], maxBytes: number) => {
  const fitted: ContextFile[] = [];
  let remaining = maxBytes;

  for (const file of files) {
    if (remaining <= 0) {
      break;
    }

    const size = byteLength(file.content);

    fitted.push(
      size <= remaining
        ? file
        : {
            ...file,
            content: truncateToBytes(file.content, remaining),
            truncated: true,
          },
    );
    remaining -= size;
  }

  return fitted;
};

/**
 * Gathers what the reviewer should know beyond the diff. Context is best
 * effort: anything GitHub fails to return is logged and left out, and a
 * review never fails for want of it.
 */
export const fetchRepositoryContext = (input: RepositoryContextInput) =>
  Effect.gen(function* () {
    const client = yield* GitHubPullRequestClient;

    const readFile = (path: string, gitRef: string, maxBytes: number) =>
      client
        .fetchRepositoryFile(input.installationToken, input.ref, path, gitRef)
        .pipe(
          Effect.map(
            Option.map((content): ContextFile =>
              byteLength(content) <= maxBytes
                ? { path, content, truncated: false }
                : {
                    path,
                    content: truncateToBytes(content, maxBytes),
                    truncated: true,
                  },
            ),
          ),
          Effect.catchAll((error) =>
            logError("repository_context_file_failed", {
              path,
              errorCode: error._tag,
            }).pipe(Effect.as(Option.none<ContextFile>())),
          ),
        );

    const readFiles = (
      paths: readonly string[],
      gitRef: string,
      maxBytes: number,
    ) =>
      Effect.forEach(paths, (path) => readFile(path, gitRef, maxBytes), {
        concurrency: FETCH_CONCURRENCY,
      }).pipe(Effect.map((files) => files.flatMap(Option.toArray)));

    const listFiles = (gitRef: string) =>
      client.fetchTree(input.installationToken, input.ref, gitRef).pipe(
        Effect.map(Option.some),
        Effect.catchAll((error) =>
          logError("repository_context_tree_failed", {
            gitRef,
            errorCode: error._tag,
          }).pipe(Effect.as(Option.none<readonly RepositoryTreeEntry[]>())),
        ),
      );

    // Guidelines are discovered on the default branch too: a pull request
    // that deletes or renames AGENTS.md must still be held to it.
    const [headTree, defaultTree] = yield* Effect.all(
      [listFiles(input.headSha), listFiles(input.defaultBranch)],
      { concurrency: "unbounded" },
    );

    if (Option.isNone(headTree) && Option.isNone(defaultTree)) {
      return null;
    }

    const sizes = new Map(
      Option.getOrElse(headTree, () => []).map((entry) => [
        entry.path,
        entry.sizeBytes,
      ]),
    );

    const blobPaths = [...sizes.keys()];

    const defaultBranchPaths = Option.getOrElse(defaultTree, () => []).map(
      (entry) => entry.path,
    );

    const changedFiles = parseUnifiedDiff(input.diff).filter(
      (file) => file.status !== "removed" && file.hunks.length > 0,
    );

    const changedPaths = changedFiles.map((file) => file.path);

    const { selected, omitted } = selectFiles(
      changedFiles
        .filter((file) => file.status !== "added")
        .map((file) => ({
          path: file.path,
          addedLines: file.hunks
            .flatMap((hunk) => hunk.lines)
            .filter((line) => line.kind === "added").length,
        })),
      sizes,
    );

    // Guidelines come from the default branch: the pull request must not
    // be able to rewrite the rules it is reviewed against.
    const [guidelines, manifests, files] = yield* Effect.all(
      [
        readFiles(
          guidelinePaths(
            input.guidelines,
            defaultBranchPaths,
            changedPaths,
          ).slice(0, MAX_GUIDELINE_FILES),
          input.defaultBranch,
          GUIDELINES_MAX_BYTES,
        ),
        readFiles(
          manifestPaths(blobPaths, changedPaths),
          input.headSha,
          MANIFEST_MAX_BYTES,
        ),
        readFiles(selected, input.headSha, FILE_MAX_BYTES),
      ],
      { concurrency: "unbounded" },
    );

    const shown = new Set(files.map((file) => file.path));

    const context: RepositoryContext = {
      guidelinesRef: input.defaultBranch,
      guidelines: fitToBudget(guidelines, GUIDELINES_MAX_BYTES),
      manifests,
      files,
      omittedFiles: [
        ...omitted,
        ...selected.filter((path) => !shown.has(path)),
      ],
    };

    return context;
  });

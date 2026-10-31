/**
 * A pull request checked out on disk, read through git: the file source for
 * repository context and the search behind related code.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Effect, Option } from "effect";

import type {
  CodeHit,
  CodeSearch,
} from "../../src/application/related-code.js";
import type { RepositorySource } from "../../src/application/repository-context.js";

const run = promisify(execFile);

// Large enough for any file worth showing; bigger ones are cut anyway.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const git = (repo: string, args: readonly string[]) =>
  Effect.tryPromise(() =>
    run("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    }),
  ).pipe(
    Effect.map(({ stdout }) => Option.some(stdout)),
    // A missing ref or path, or a search with no matches (exit 1).
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

// `git ls-tree -l`: "<mode> <type> <object> <size>\t<path>".
const TREE_ENTRY = /^\d+ blob \S+ +(\d+)\t(.+)$/;

// `git grep -n`: "<path>:<line>:<text>".
const GREP_HIT = /^(.+?):(\d+):/;

export const checkoutSource = (repo: string): RepositorySource => ({
  listFiles: (gitRef) =>
    git(repo, ["ls-tree", "-r", "-l", gitRef]).pipe(
      Effect.map(
        Option.map((output) =>
          lines(output).flatMap((line) => {
            const match = TREE_ENTRY.exec(line);

            return match?.[1] === undefined || match[2] === undefined
              ? []
              : [{ path: match[2], sizeBytes: Number(match[1]) }];
          }),
        ),
      ),
    ),
  readFile: (path, gitRef) => git(repo, ["show", `${gitRef}:${path}`]),
});

/** Searches the working tree, which is the pull request's head. */
export const checkoutSearch = (repo: string): CodeSearch => ({
  listFiles: git(repo, ["ls-files"]).pipe(
    Effect.map((output) => lines(Option.getOrElse(output, () => ""))),
  ),
  findWord: (word, limit) =>
    git(repo, ["grep", "-n", "-I", "-w", "-F", "--no-color", "-e", word]).pipe(
      Effect.map((output) =>
        lines(Option.getOrElse(output, () => ""))
          .slice(0, limit)
          .flatMap((line): CodeHit[] => {
            const match = GREP_HIT.exec(line);

            return match?.[1] === undefined || match[2] === undefined
              ? []
              : [{ path: match[1], line: Number(match[2]) }];
          }),
      ),
    ),
  readFile: (path) => git(repo, ["show", `HEAD:${path}`]),
});

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: DiffFileStatus;
  readonly hunks: readonly DiffHunk[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const stripDiffPathPrefix = (path: string) => {
  if (path === "/dev/null") {
    return null;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }

  return path;
};

interface FileBuilder {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  renamedFrom: string | null;
  renamedTo: string | null;
  hunks: DiffHunk[];
}

const emptyFileBuilder = (): FileBuilder => ({
  oldPath: null,
  newPath: null,
  isNew: false,
  isDeleted: false,
  renamedFrom: null,
  renamedTo: null,
  hunks: [],
});

const finalizeFile = (builder: FileBuilder): DiffFile | null => {
  const path =
    builder.newPath ??
    builder.renamedTo ??
    builder.oldPath ??
    builder.renamedFrom;

  if (path === null) {
    return null;
  }

  if (builder.isNew) {
    return { path, previousPath: null, status: "added", hunks: builder.hunks };
  }

  if (builder.isDeleted) {
    const deletedPath = builder.oldPath ?? path;

    return {
      path: deletedPath,
      previousPath: null,
      status: "removed",
      hunks: builder.hunks,
    };
  }

  if (builder.renamedFrom !== null) {
    return {
      path,
      previousPath: builder.renamedFrom,
      status: "renamed",
      hunks: builder.hunks,
    };
  }

  return { path, previousPath: null, status: "modified", hunks: builder.hunks };
};

interface HunkBuilder {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  nextOldLine: number;
  nextNewLine: number;
  lines: DiffLine[];
}

const startHunk = (headerMatch: RegExpMatchArray): HunkBuilder | null => {
  const [, oldStart, oldLines, newStart, newLines, header] = headerMatch;

  if (oldStart === undefined || newStart === undefined) {
    return null;
  }

  const oldStartNumber = Number(oldStart);
  const newStartNumber = Number(newStart);

  return {
    oldStart: oldStartNumber,
    oldLines: oldLines === undefined ? 1 : Number(oldLines),
    newStart: newStartNumber,
    newLines: newLines === undefined ? 1 : Number(newLines),
    header: (header ?? "").trim(),
    nextOldLine: oldStartNumber,
    nextNewLine: newStartNumber,
    lines: [],
  };
};

const finalizeHunk = (builder: HunkBuilder): DiffHunk => ({
  oldStart: builder.oldStart,
  oldLines: builder.oldLines,
  newStart: builder.newStart,
  newLines: builder.newLines,
  header: builder.header,
  lines: builder.lines,
});

const appendHunkLine = (builder: HunkBuilder, line: string): boolean => {
  if (line.startsWith("+")) {
    builder.lines.push({
      kind: "added",
      content: line.slice(1),
      oldLine: null,
      newLine: builder.nextNewLine,
    });

    builder.nextNewLine += 1;

    return true;
  }

  if (line.startsWith("-")) {
    builder.lines.push({
      kind: "removed",
      content: line.slice(1),
      oldLine: builder.nextOldLine,
      newLine: null,
    });

    builder.nextOldLine += 1;

    return true;
  }

  if (line.startsWith(" ") || line === "") {
    builder.lines.push({
      kind: "context",
      content: line.slice(1),
      oldLine: builder.nextOldLine,
      newLine: builder.nextNewLine,
    });

    builder.nextOldLine += 1;
    builder.nextNewLine += 1;

    return true;
  }

  return line.startsWith("\\");
};

/**
 * Parses a unified diff (as returned by GitHub's
 * `application/vnd.github.diff` media type) into per-file hunks with old and
 * new line numbers, so findings can anchor pull request review comments.
 *
 * The parser is lenient and total: unrecognized lines are skipped rather than
 * failing, since GitHub's output may include metadata lines (index, mode
 * changes, binary notices) that carry no review-relevant content.
 */
export const parseUnifiedDiff = (diff: string): readonly DiffFile[] => {
  const files: DiffFile[] = [];
  let file: FileBuilder | null = null;
  let hunk: HunkBuilder | null = null;

  const closeHunk = () => {
    if (hunk !== null && file !== null) {
      file.hunks.push(finalizeHunk(hunk));
    }

    hunk = null;
  };

  const closeFile = () => {
    closeHunk();

    if (file !== null) {
      const finalized = finalizeFile(file);

      if (finalized !== null) {
        files.push(finalized);
      }
    }

    file = null;
  };

  // A trailing newline at end of input is a line terminator, not an empty
  // context line; splitting without stripping it would fabricate one.
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeFile();

      file = emptyFileBuilder();

      continue;
    }

    if (file === null) {
      continue;
    }

    if (hunk !== null && appendHunkLine(hunk, line)) {
      continue;
    }

    const headerMatch = line.match(HUNK_HEADER_PATTERN);

    if (headerMatch !== null) {
      closeHunk();

      hunk = startHunk(headerMatch);

      continue;
    }

    closeHunk();

    if (line.startsWith("--- ")) {
      file.oldPath = stripDiffPathPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      file.newPath = stripDiffPathPrefix(line.slice(4));
    } else if (line.startsWith("new file mode")) {
      file.isNew = true;
    } else if (line.startsWith("deleted file mode")) {
      file.isDeleted = true;
    } else if (line.startsWith("rename from ")) {
      file.renamedFrom = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.renamedTo = line.slice("rename to ".length);
    }
  }

  closeFile();

  return files;
};

const DEFAULT_IGNORED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb?$/,
  /\.min\.(js|css)$/,
  /(^|\/)drizzle\/.+\.sql$/,
  /(^|\/)drizzle\/meta\//,
  /(^|\/)worker-configuration\.d\.ts$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?)$/,
  /\.snap$/,
];

export const isIgnoredDiffPath = (path: string): boolean =>
  DEFAULT_IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));

export const reviewableDiffFiles = (
  files: readonly DiffFile[],
): readonly DiffFile[] => files.filter((file) => !isIgnoredDiffPath(file.path));

/**
 * Collects the new-file line numbers of added lines per file. These are the
 * positions a GitHub pull request review comment can anchor to with
 * `side: RIGHT`.
 */
export const commentableLinesByFile = (
  files: readonly DiffFile[],
): ReadonlyMap<string, ReadonlySet<number>> => {
  const map = new Map<string, Set<number>>();

  for (const file of files) {
    const lines = new Set<number>();

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added" && line.newLine !== null) {
          lines.add(line.newLine);
        }
      }
    }

    if (lines.size > 0) {
      map.set(file.path, lines);
    }
  }

  return map;
};

/**
 * Removes ignored file blocks from a raw unified diff, preserving the exact
 * original text of the remaining blocks so line numbers stay valid.
 */
export const filterUnifiedDiff = (diff: string): string =>
  diff
    .split(/^(?=diff --git )/m)
    .filter((block) => {
      if (!block.startsWith("diff --git ")) {
        return true;
      }

      const file = parseUnifiedDiff(block)[0];

      return file === undefined ? false : !isIgnoredDiffPath(file.path);
    })
    .join("");

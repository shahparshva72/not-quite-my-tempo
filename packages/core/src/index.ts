import { Effect } from "effect";

export {
  commentableLinesByFile,
  filterUnifiedDiff,
  isIgnoredDiffPath,
  parseUnifiedDiff,
  reviewableDiffFiles,
} from "./diff.js";

export type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffLineKind,
} from "./diff.js";

export interface HealthStatus {
  readonly status: "ok";
}

export interface ServiceInfo {
  readonly name: string;
  readonly health: Effect.Effect<HealthStatus>;
}

export const makeServiceInfo = (name: string): ServiceInfo => ({
  name,
  health: Effect.succeed({ status: "ok" }),
});

import { Effect } from "effect";

export {
  commentableLinesByFile,
  filterUnifiedDiff,
  globToRegExp,
  isIgnoredDiffPath,
  parseUnifiedDiff,
  reviewableDiffFiles,
} from "./diff.js";

export {
  defaultReviewConfig,
  REVIEW_CONFIG_PATH,
  ReviewConfig,
  ReviewIntensity,
  ReviewSeverityThreshold,
} from "./review-config.js";

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

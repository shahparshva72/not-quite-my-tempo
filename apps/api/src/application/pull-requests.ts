import { Effect, Inspectable } from "effect";
import { PullRequestRepository } from "@not-quite-my-tempo/db";
import type { PullRequestSnapshot } from "@not-quite-my-tempo/db";

import { logError, logInfo } from "../logging.js";

/**
 * Stores a pull request's latest details for the dashboard. They only
 * label pages, so a storage failure is logged and never fails the
 * webhook (or the review it may have queued).
 */
export const recordPullRequest = (snapshot: PullRequestSnapshot) => {
  const fields = {
    githubRepositoryId: snapshot.githubRepositoryId,
    pullRequestNumber: snapshot.number,
    state: snapshot.state,
  };

  return PullRequestRepository.record(snapshot).pipe(
    Effect.flatMap((written) =>
      written ? logInfo("pull_request_recorded", fields) : Effect.void,
    ),
    Effect.catchAll((error) =>
      logError("pull_request_record_failed", {
        ...fields,
        error: Inspectable.toStringUnknown(error.cause),
      }),
    ),
  );
};

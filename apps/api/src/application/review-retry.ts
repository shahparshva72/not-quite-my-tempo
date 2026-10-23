import { Effect, Option } from "effect";
import {
  GitHubInstallationRepository,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";

import { logInfo } from "../logging.js";
import { authorizeRepository, ResourceNotFoundError } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";
import { queueManualReview } from "./review-requests.js";

const orNotFound = <A>(found: Option.Option<A>) =>
  Option.match(found, {
    onNone: () => Effect.fail(new ResourceNotFoundError()),
    onSome: Effect.succeed,
  });

/**
 * The dashboard's "Retry review" on a failed run: the same request as
 * commenting `/fletcher again` on its pull request, made by an admin.
 * The pull request's current head is reviewed, so a newer push gets its
 * own run. A run that isn't failed is left alone.
 */
export const retryFailedReview = (access: SessionAccess, reviewRunId: number) =>
  Effect.gen(function* () {
    const run = yield* ReviewRunRepository.findById(reviewRunId).pipe(
      Effect.flatMap(orNotFound),
    );

    const { repository } = yield* authorizeRepository(
      access,
      run.repositoryId,
      "retry_review",
    );

    if (run.status !== "failed") {
      return { status: "not_failed" as const, reviewRunId: run.id };
    }

    const installation = yield* GitHubInstallationRepository.findById(
      repository.installationId,
    ).pipe(Effect.flatMap(orNotFound));

    yield* logInfo("dashboard_retry_requested", {
      userId: access.userId,
      reviewRunId: run.id,
    });

    const { outcome } = yield* queueManualReview({
      installationId: installation.githubInstallationId,
      installationAccountId: installation.githubAccountId,
      installationAccountType: installation.accountType,
      githubRepositoryId: repository.githubRepositoryId,
      owner: repository.owner,
      repo: repository.name,
      defaultBranch: repository.defaultBranch,
      pullRequestNumber: run.pullRequestNumber,
    });

    return outcome;
  });

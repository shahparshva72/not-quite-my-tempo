import type { D1Database } from "@cloudflare/workers-types";
import { Layer } from "effect";

import { FindingRepository } from "../repositories/finding-repository.js";
import { GitHubInstallationRepository } from "../repositories/github-installation-repository.js";
import { GitHubRepositoryRepository } from "../repositories/github-repository-repository.js";
import { MembershipRepository } from "../repositories/membership-repository.js";
import { ReviewRunRepository } from "../repositories/review-run-repository.js";
import { SessionRepository } from "../repositories/session-repository.js";
import { UserRepository } from "../repositories/user-repository.js";
import { DatabaseLive } from "../services/database.js";

export const makeLiveLayer = (database: D1Database) =>
  Layer.mergeAll(
    FindingRepository.Default,
    GitHubInstallationRepository.Default,
    GitHubRepositoryRepository.Default,
    MembershipRepository.Default,
    ReviewRunRepository.Default,
    SessionRepository.Default,
    UserRepository.Default,
  ).pipe(Layer.provide(DatabaseLive(database)));

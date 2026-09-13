import type { D1Database } from "@cloudflare/workers-types";
import { Layer } from "effect";

import { FindingRepository } from "../repositories/finding-repository.js";
import { GitHubInstallationRepository } from "../repositories/github-installation-repository.js";
import { GitHubRepositoryRepository } from "../repositories/github-repository-repository.js";
import { ReviewRunRepository } from "../repositories/review-run-repository.js";
import { DatabaseLive } from "../services/database.js";

export const makeLiveLayer = (database: D1Database) =>
  Layer.mergeAll(
    FindingRepository.Default,
    GitHubInstallationRepository.Default,
    GitHubRepositoryRepository.Default,
    ReviewRunRepository.Default,
  ).pipe(Layer.provide(DatabaseLive(database)));

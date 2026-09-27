import { Context, Data, Effect, Layer, Schema } from "effect";
import type { InstallationRepositoryInput } from "@not-quite-my-tempo/db";

import { GitHubId } from "./review-request.js";

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

const USER_AGENT = "not-quite-my-tempo";

const PAGE_SIZE = 100;

export class InstallationRepositoriesRequestError extends Data.TaggedError(
  "InstallationRepositoriesRequestError",
)<{
  readonly cause: unknown;
}> {}

export class InstallationRepositoriesResponseError extends Data.TaggedError(
  "InstallationRepositoriesResponseError",
)<{
  readonly status: number;
  readonly body: string;
}> {}

export type InstallationRepositoriesError =
  | InstallationRepositoriesRequestError
  | InstallationRepositoriesResponseError;

const InstallationRepositoriesResponse = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      id: GitHubId,
      name: Schema.NonEmptyString,
      default_branch: Schema.NonEmptyString,
      owner: Schema.Struct({ login: Schema.NonEmptyString }),
    }),
  ),
});

export interface GitHubInstallationClientService {
  /**
   * Lists every repository the installation token can access, following
   * pagination. Installation webhooks carry only partial repository objects
   * (no default branch), so syncs read the authoritative list here.
   */
  readonly listRepositories: (
    installationToken: string,
  ) => Effect.Effect<
    readonly InstallationRepositoryInput[],
    InstallationRepositoriesError
  >;
}

export class GitHubInstallationClient extends Context.Tag(
  "@not-quite-my-tempo/api/GitHubInstallationClient",
)<GitHubInstallationClient, GitHubInstallationClientService>() {}

export interface GitHubInstallationClientConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const fetchRepositoryPage = (
  config: GitHubInstallationClientConfig,
  installationToken: string,
  page: number,
) =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl ?? GITHUB_API_BASE_URL;

    const fetchImpl =
      config.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `${baseUrl}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
          {
            method: "GET",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${installationToken}`,
              "user-agent": USER_AGENT,
              "x-github-api-version": GITHUB_API_VERSION,
            },
          },
        ),
      catch: (cause) => new InstallationRepositoriesRequestError({ cause }),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new InstallationRepositoriesRequestError({ cause }),
    });

    if (!response.ok) {
      return yield* new InstallationRepositoriesResponseError({
        status: response.status,
        body,
      });
    }

    const decoded = yield* Schema.decodeUnknown(
      Schema.parseJson(InstallationRepositoriesResponse),
    )(body).pipe(
      Effect.mapError(
        (cause) => new InstallationRepositoriesRequestError({ cause }),
      ),
    );

    return decoded.repositories.map(
      (repository): InstallationRepositoryInput => ({
        githubRepositoryId: repository.id,
        owner: repository.owner.login,
        name: repository.name,
        defaultBranch: repository.default_branch,
      }),
    );
  });

export const GitHubInstallationClientLive = (
  config: GitHubInstallationClientConfig,
) =>
  Layer.succeed(
    GitHubInstallationClient,
    GitHubInstallationClient.of({
      listRepositories: (installationToken) =>
        Effect.gen(function* () {
          const repositories: InstallationRepositoryInput[] = [];
          let page = 1;

          while (true) {
            const pageRepositories = yield* fetchRepositoryPage(
              config,
              installationToken,
              page,
            );

            repositories.push(...pageRepositories);

            if (pageRepositories.length < PAGE_SIZE) {
              return repositories;
            }

            page += 1;
          }
        }),
    }),
  );

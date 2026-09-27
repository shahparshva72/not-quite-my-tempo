import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { makeLiveLayer, UserRepository } from "@not-quite-my-tempo/db";

import { createSession } from "../src/auth/session";

export const TEST_SESSION_SECRET = "test-session-secret";

export const sessionCookie = (repositoryIds: readonly number[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const user = yield* UserRepository.upsert({
        githubUserId: 4001,
        login: "neiman",
      });

      const token = yield* createSession(
        TEST_SESSION_SECRET,
        user.id,
        repositoryIds,
      );

      return `nqmt_session=${token}`;
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

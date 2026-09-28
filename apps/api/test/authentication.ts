import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { makeLiveLayer, UserRepository } from "@not-quite-my-tempo/db";
import type { WorkspaceRole } from "@not-quite-my-tempo/db";

import type { SessionAccess } from "../src/application/authorization";
import { createSession } from "../src/auth/session";

export const TEST_SESSION_SECRET = "test-session-secret";

// 32 zero bytes, base64. Tests must not depend on a developer's .dev.vars.
export const TEST_TOKEN_ENCRYPTION_KEY = btoa("\0".repeat(32));

/**
 * Upserts the test user (GitHub 4001, "neiman") and gives them `role` in the
 * seeded workspace 1, as a sign-in would.
 */
const seedMember = (role: WorkspaceRole) =>
  Effect.gen(function* () {
    const user = yield* UserRepository.upsert({
      githubUserId: 4001,
      login: "neiman",
    });

    yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT INTO memberships (workspace_id, user_id, github_owner, app_role, verified_at)
         VALUES (1, ?, ?, ?, 0)
         ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET github_owner = excluded.github_owner, app_role = excluded.app_role`,
      )
        .bind(
          user.id,
          role === "owner" ? 1 : 0,
          role === "owner" ? "member" : role,
        )
        .run(),
    );

    return user;
  });

export const testAccess = (
  repositoryIds: readonly number[],
  role: WorkspaceRole = "admin",
) =>
  Effect.runPromise(
    seedMember(role).pipe(
      Effect.map((user): SessionAccess => ({ userId: user.id, repositoryIds })),
      Effect.provide(makeLiveLayer(env.DB)),
    ),
  );

export const sessionCookie = (
  repositoryIds: readonly number[],
  role: WorkspaceRole = "admin",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const user = yield* seedMember(role);

      const token = yield* createSession(
        TEST_SESSION_SECRET,
        user.id,
        repositoryIds,
      );

      return `nqmt_session=${token}`;
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

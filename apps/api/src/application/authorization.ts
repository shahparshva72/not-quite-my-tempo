import { Data, Effect, Option } from "effect";
import {
  GitHubRepositoryRepository,
  MembershipRepository,
} from "@not-quite-my-tempo/db";
import type { WorkspaceRole } from "@not-quite-my-tempo/db";

import { logInfo } from "../logging.js";

/**
 * What a signed-in user can reach: their account and the GitHub repository
 * IDs verified at the last access refresh. Every read and write takes this
 * rather than bare IDs, so the policy below is the only way in.
 */
export interface SessionAccess {
  readonly userId: number;
  readonly repositoryIds: readonly number[];
}

/**
 * The resource does not exist or the user may not see it. Both map to the
 * same 404 so IDs cannot be probed.
 */
export class ResourceNotFoundError extends Data.TaggedError(
  "ResourceNotFoundError",
) {}

/** The user can see the resource but their role is too low for the action. */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly role: WorkspaceRole;
  readonly requiredRole: WorkspaceRole;
}> {}

export type RepositoryAction = "view" | "toggle_reviews";

const roleRank = { member: 0, admin: 1, owner: 2 } as const;

const requiredRoles = {
  view: "member",
  toggle_reviews: "admin",
} as const satisfies Record<RepositoryAction, WorkspaceRole>;

export const roleAllows = (role: WorkspaceRole, required: WorkspaceRole) =>
  roleRank[role] >= roleRank[required];

export const repositoryActionAllowed = (
  role: WorkspaceRole,
  action: RepositoryAction,
) => roleAllows(role, requiredRoles[action]);

/** Repositories the user may see, each with their role in its workspace. */
export const visibleRepositories = (access: SessionAccess) =>
  GitHubRepositoryRepository.listVisibleToUser(
    access.userId,
    access.repositoryIds,
  );

/**
 * The single authorization check for repository reads and writes: the user
 * must be a member of the repository's workspace, see the repository on
 * GitHub, and hold the role the action needs.
 */
export const authorizeRepository = (
  access: SessionAccess,
  repositoryId: number,
  action: RepositoryAction,
) =>
  Effect.gen(function* () {
    const [visible] = yield* GitHubRepositoryRepository.listVisibleToUser(
      access.userId,
      access.repositoryIds,
      repositoryId,
    );

    if (visible === undefined) {
      return yield* new ResourceNotFoundError();
    }

    const requiredRole = requiredRoles[action];

    if (!roleAllows(visible.role, requiredRole)) {
      yield* logInfo("authorization_denied", {
        userId: access.userId,
        repositoryId,
        action,
        role: visible.role,
        requiredRole,
      });

      return yield* new ForbiddenError({ role: visible.role, requiredRole });
    }

    return visible;
  });

export type WorkspaceAction = "view_members" | "manage_roles";

const workspaceRequiredRoles = {
  view_members: "member",
  manage_roles: "owner",
} as const satisfies Record<WorkspaceAction, WorkspaceRole>;

export const workspaceActionAllowed = (
  role: WorkspaceRole,
  action: WorkspaceAction,
) => roleAllows(role, workspaceRequiredRoles[action]);

/**
 * The workspace-level check: the user must be a member (404 otherwise, so
 * workspace IDs can't be probed) and hold the role the action needs.
 */
export const authorizeWorkspace = (
  access: SessionAccess,
  workspaceId: number,
  action: WorkspaceAction,
) =>
  Effect.gen(function* () {
    const membership = yield* MembershipRepository.findForUser(
      workspaceId,
      access.userId,
    );

    if (Option.isNone(membership)) {
      return yield* new ResourceNotFoundError();
    }

    const requiredRole = workspaceRequiredRoles[action];

    if (!roleAllows(membership.value.role, requiredRole)) {
      yield* logInfo("authorization_denied", {
        userId: access.userId,
        workspaceId,
        action,
        role: membership.value.role,
        requiredRole,
      });

      return yield* new ForbiddenError({
        role: membership.value.role,
        requiredRole,
      });
    }

    return membership.value;
  });

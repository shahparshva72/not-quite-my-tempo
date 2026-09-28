import { Data, Effect, Option } from "effect";
import { MembershipRepository } from "@not-quite-my-tempo/db";

import { logInfo } from "../logging.js";
import { authorizeWorkspace, ResourceNotFoundError } from "./authorization.js";
import type { SessionAccess } from "./authorization.js";

/** Owners come from GitHub, so their role can't be changed in-app. */
export class OwnerRoleError extends Data.TaggedError("OwnerRoleError") {}

/** Members page data: the workspace, the viewer's role, and its members. */
export const workspaceMembers = (access: SessionAccess, workspaceId: number) =>
  Effect.gen(function* () {
    const viewer = yield* authorizeWorkspace(
      access,
      workspaceId,
      "view_members",
    );

    const members = yield* MembershipRepository.listForWorkspace(workspaceId);

    return {
      workspace: viewer.workspace,
      viewerRole: viewer.role,
      viewerUserId: access.userId,
      members,
    };
  });

/**
 * Makes a member an admin or back. Owner only; the target must belong to
 * the workspace and not be an owner. Setting the role it already has is a
 * no-op, so double submits record nothing.
 */
export const changeAdminRole = (
  access: SessionAccess,
  workspaceId: number,
  targetUserId: number,
  to: "admin" | "member",
) =>
  Effect.gen(function* () {
    yield* authorizeWorkspace(access, workspaceId, "manage_roles");

    const target = yield* MembershipRepository.findForUser(
      workspaceId,
      targetUserId,
    );

    if (Option.isNone(target)) {
      return yield* new ResourceNotFoundError();
    }

    const from = target.value.role;

    if (from === "owner") {
      return yield* new OwnerRoleError();
    }

    if (from === to) {
      return;
    }

    yield* MembershipRepository.setAppRoleWithAudit({
      workspaceId,
      targetUserId,
      actorUserId: access.userId,
      from,
      to,
    });

    yield* logInfo("role_changed", {
      workspaceId,
      targetUserId,
      actorUserId: access.userId,
      from,
      to,
    });
  });

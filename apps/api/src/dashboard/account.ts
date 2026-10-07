import { Match } from "effect";
import { html } from "hono/html";
import type {
  WorkspaceMembership,
  WorkspaceRole,
} from "@not-quite-my-tempo/db";

import { avatar, icon, layout, messagePage, pageHead } from "./components.js";

export type AccountNotice = "confirmation_mismatch" | "workspace_deleted";

const roleLabels = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const satisfies Record<WorkspaceRole, string>;

const accountNotice = (notice: AccountNotice | null) =>
  Match.value(notice).pipe(
    Match.when(null, () => ""),
    Match.when(
      "workspace_deleted",
      () =>
        html`<p class="notice" role="status">
          ${icon("check")}<span
            >Workspace data deleted, and Fletcher was uninstalled from that
            GitHub account.</span
          >
        </p>`,
    ),
    Match.when(
      "confirmation_mismatch",
      () =>
        html`<p class="notice notice-error" role="alert">
          ${icon("info")}<span
            >That doesn't match your GitHub username, so nothing was deleted.
            Type it exactly as shown.</span
          >
        </p>`,
    ),
    Match.exhaustive,
  );

const workspaceEntry = ({ workspace, role }: WorkspaceMembership) =>
  html`<li class="entry">
    <span class="entry-mark">${avatar(workspace.githubAccountLogin)}</span>
    <div>
      <p class="entry-title">
        <a href="/workspaces/${workspace.id}/settings"
          >${workspace.githubAccountLogin}</a
        >
        <span class="badge${role === "member" ? "" : " badge-on"}"
          >${roleLabels[role]}</span
        >
      </p>
    </div>
    <a
      class="entry-go"
      href="/workspaces/${workspace.id}/settings"
      aria-hidden="true"
      tabindex="-1"
      >${icon("chevronRight")}</a
    >
  </li>`;

/** The signed-in user's account: their workspaces and account deletion. */
export const accountPage = (
  login: string,
  workspaces: readonly WorkspaceMembership[],
  notice: AccountNotice | null,
) => {
  const owned = workspaces.filter(({ role }) => role === "owner");

  return layout(
    "Your account",
    login,
    html`${pageHead("Your account", `Signed in with GitHub as ${login}.`)}
      ${accountNotice(notice)}
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Workspaces</h2></div>
          ${
            workspaces.length === 0
              ? html`<div class="card-body">
                  <p class="quiet">You're not a member of any workspace.</p>
                </div>`
              : html`<ul class="entries">
                  ${workspaces.map(workspaceEntry)}
                </ul>`
          }
          <div class="card-foot">
            <p class="fine">
              A workspace belongs to its GitHub account, not to you. Owners can
              delete a workspace's data from its settings.
            </p>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Delete your account</h2></div>
          <div class="card-body">
            <p>
              Deletes your Fletcher account, your sessions, and your roles in
              every workspace, and revokes Fletcher's access to your GitHub
              account. You can sign in again later as a new account.
            </p>
            <p class="fine">
              Workspaces and their review history stay, because they belong to
              their GitHub accounts. Reviews already posted on pull requests
              stay on GitHub. Polar keeps billing records as the law requires.
            </p>
            ${
              owned.length === 0
                ? ""
                : html`<p class="notice" role="note">
                    ${icon("info")}<span
                      >You own
                      ${owned.map(
                        ({ workspace }, index) =>
                          html`${index === 0 ? "" : ", "}<a
                              href="/workspaces/${workspace.id}/settings"
                              >${workspace.githubAccountLogin}</a
                            >`,
                      )}.
                      Deleting your account doesn't delete
                      ${owned.length === 1 ? "it" : "them"}: Fletcher keeps
                      reviewing until an owner deletes the workspace's data or
                      uninstalls Fletcher on GitHub.</span
                    >
                  </p>`
            }
            <form class="key-form" method="post" action="/account/delete">
              <label for="confirm-account"
                >Type your GitHub username, ${login}, to confirm</label
              >
              <input
                id="confirm-account"
                name="confirm"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                required
              />
              <button class="btn btn-danger" type="submit">
                Delete my account
              </button>
            </form>
          </div>
        </section>
      </div>`,
    "account",
  );
};

export const accountDeletedPage = () =>
  messagePage(
    "Your account is deleted",
    null,
    html`<p>
        Your Fletcher account, sessions, and roles are gone. If Fletcher still
        appears under Authorized GitHub Apps in your GitHub settings, you can
        revoke it there.
      </p>
      <a class="btn" href="/">Back to the home page</a>`,
  );

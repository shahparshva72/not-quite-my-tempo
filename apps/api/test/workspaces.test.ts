import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitHubInstallationRepository,
  makeLiveLayer,
} from "@not-quite-my-tempo/db";

import backfillWorkspaces from "../../../packages/db/drizzle/0006_backfill_workspaces.sql?raw";
import { resetAndSeedRepository } from "./database";

const runBackfill = () =>
  env.DB.batch(
    backfillWorkspaces
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "")
      .map((statement) => env.DB.prepare(statement)),
  );

const workspaceRows = () =>
  env.DB.prepare(
    "SELECT id, github_account_id, github_account_login, account_type FROM workspaces ORDER BY github_account_id",
  )
    .all()
    .then((result) => result.results);

const installationLinks = () =>
  env.DB.prepare(
    `SELECT i.github_installation_id, w.github_account_id
       FROM github_installations i
       LEFT JOIN workspaces w ON w.id = i.workspace_id
      ORDER BY i.github_installation_id`,
  )
    .all()
    .then((result) => result.results);

const upsert = (
  githubInstallationId: number,
  githubAccountId: number,
  githubAccountLogin: string,
) =>
  Effect.runPromise(
    GitHubInstallationRepository.upsert({
      githubInstallationId,
      githubAccountId,
      githubAccountLogin,
      accountType: "Organization",
    }).pipe(Effect.provide(makeLiveLayer(env.DB))),
  );

describe("workspace backfill migration", () => {
  beforeEach(async () => {
    await resetAndSeedRepository();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM repositories"),
      env.DB.prepare("DELETE FROM github_installations"),
      env.DB.prepare("DELETE FROM workspaces"),
      env.DB.prepare(
        `INSERT INTO github_installations
          (github_installation_id, github_account_id, github_account_login, account_type, updated_at)
         VALUES
          (1001, 2001, 'old-name', 'Organization', 1000),
          (1002, 2001, 'tempo-band', 'Organization', 2000),
          (1003, 2002, 'neiman', 'User', 1000)`,
      ),
    ]);
  });

  it("creates one workspace per account, named from its latest installation", async () => {
    await runBackfill();

    expect(await workspaceRows()).toMatchObject([
      {
        github_account_id: 2001,
        github_account_login: "tempo-band",
        account_type: "Organization",
      },
      {
        github_account_id: 2002,
        github_account_login: "neiman",
        account_type: "User",
      },
    ]);
    expect(await installationLinks()).toEqual([
      { github_installation_id: 1001, github_account_id: 2001 },
      { github_installation_id: 1002, github_account_id: 2001 },
      { github_installation_id: 1003, github_account_id: 2002 },
    ]);
  });

  it("changes nothing when run a second time", async () => {
    await runBackfill();
    const before = await workspaceRows();

    await runBackfill();

    expect(await workspaceRows()).toEqual(before);
  });
});

describe("installation upsert", () => {
  beforeEach(resetAndSeedRepository);

  it("creates the account's workspace with a new installation", async () => {
    const installation = await upsert(5005, 6006, "fresh-org");

    const workspace = await env.DB.prepare(
      "SELECT id, github_account_login FROM workspaces WHERE github_account_id = 6006",
    ).first<{ id: number; github_account_login: string }>();

    expect(workspace?.github_account_login).toBe("fresh-org");
    expect(installation.workspaceId).toBe(workspace?.id);
  });

  it("re-attaches a reinstall to the same workspace and follows renames", async () => {
    const first = await upsert(1001, 2001, "not-my-tempo");
    const reinstall = await upsert(1009, 2001, "renamed-band");

    expect(reinstall.workspaceId).toBe(first.workspaceId);
    expect(await workspaceRows()).toMatchObject([
      { github_account_id: 2001, github_account_login: "renamed-band" },
    ]);
  });

  it("converges on one workspace when installations are saved concurrently", async () => {
    const results = await Promise.all([
      upsert(7001, 8008, "race-org"),
      upsert(7002, 8008, "race-org"),
      upsert(7003, 8008, "race-org"),
    ]);

    const workspaceIds = new Set(results.map((row) => row.workspaceId));

    expect(workspaceIds.size).toBe(1);
    expect(
      (await workspaceRows()).filter(
        (row) => row["github_account_id"] === 8008,
      ),
    ).toHaveLength(1);
  });
});

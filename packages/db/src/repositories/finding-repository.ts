import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import { databaseEffect } from "../errors.js";
import { findings, findingSeverities } from "../schema/findings.js";
import { Database } from "../services/database.js";

export type Finding = typeof findings.$inferSelect;

export type FindingSeverity = (typeof findingSeverities)[number];

export interface CreateFindingInput {
  readonly filePath: string;
  readonly line: number | null;
  readonly severity: FindingSeverity;
  readonly category: string | null;
  readonly confidence: number | null;
  readonly title: string | null;
  readonly message: string;
}

export class FindingRepository extends Effect.Service<FindingRepository>()(
  "@not-quite-my-tempo/db/FindingRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { client } = yield* Database;

      return {
        insertMany: (
          reviewRunId: number,
          inputs: readonly CreateFindingInput[],
        ) =>
          inputs.length === 0
            ? Effect.succeed<readonly Finding[]>([])
            : databaseEffect("findings.insert_many", () =>
                client
                  .insert(findings)
                  .values(inputs.map((input) => ({ reviewRunId, ...input })))
                  .returning()
                  .all(),
              ),
        listByReviewRun: (reviewRunId: number) =>
          databaseEffect("findings.list_by_review_run", () =>
            client
              .select()
              .from(findings)
              .where(eq(findings.reviewRunId, reviewRunId))
              .all(),
          ),
        setGithubCommentId: (id: number, githubCommentId: number) =>
          databaseEffect("findings.set_github_comment_id", () =>
            client
              .update(findings)
              .set({ githubCommentId })
              .where(eq(findings.id, id))
              .returning()
              .get(),
          ).pipe(Effect.map(Option.fromNullable)),
      };
    }),
  },
) {}

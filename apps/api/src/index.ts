import { Effect } from "effect";
import { Hono } from "hono";
import { logger } from "hono/logger";
import {
  Database,
  DatabaseLive,
  makeLiveLayer,
  ReviewRunRepository,
} from "@not-quite-my-tempo/db";
import type { CreateReviewRunInput } from "@not-quite-my-tempo/db";
import { makeServiceInfo } from "@not-quite-my-tempo/core";
import type { Context } from "hono";

type Bindings = Env;
type AppContext = Context<{ Bindings: Bindings }>;

const serviceInfo = makeServiceInfo("not-quite-my-tempo-api");
const healthCheck = Effect.gen(function* () {
  yield* Database;
  return yield* serviceInfo.health;
});

const createAndReadReviewRun = (input: CreateReviewRunInput) =>
  Effect.gen(function* () {
    const reviewRunRepository = yield* ReviewRunRepository;
    const created = yield* reviewRunRepository.create(input);
    return yield* reviewRunRepository.findById(created.id);
  });

const app = new Hono<{ Bindings: Bindings }>();

const internalError = (c: AppContext, error: unknown) => {
  console.error(error);
  return c.json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
};

app.use("*", logger());

app.get("/", (c) =>
  c.json({
    name: serviceInfo.name,
    message: "Hono on Cloudflare Workers with D1 and Effect",
  }),
);

app.get("/health", async (c) => {
  try {
    const result = await Effect.runPromise(
      healthCheck.pipe(Effect.provide(DatabaseLive(c.env.DB))),
    );
    return c.json(result);
  } catch (error) {
    return internalError(c, error);
  }
});

app.post("/debug/review-runs", async (c) => {
  try {
    const input = await c.req.json<CreateReviewRunInput>();
    const reviewRun = await Effect.runPromise(
      createAndReadReviewRun(input).pipe(
        Effect.provide(makeLiveLayer(c.env.DB)),
      ),
    );
    return c.json(reviewRun);
  } catch (error) {
    return internalError(c, error);
  }
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Route not found" } }, 404),
);

app.onError((error, c) => internalError(c, error));

export default app;

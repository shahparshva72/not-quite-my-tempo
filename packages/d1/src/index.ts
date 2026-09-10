import { Context, Layer } from "effect";
import type { D1Database } from "@cloudflare/workers-types";

export interface D1BindingService {
  readonly database: D1Database;
}

export class D1Binding extends Context.Tag(
  "@not-quite-my-tempo/d1/D1Binding",
)<D1Binding, D1BindingService>() {}

export const D1BindingLive = (
  database: D1Database,
): Layer.Layer<D1Binding, never, never> =>
  Layer.succeed(D1Binding, { database });

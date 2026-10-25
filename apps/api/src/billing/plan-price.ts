import { Clock, Effect, Option } from "effect";

import { logError } from "../logging.js";
import { PolarClient } from "./polar-client.js";
import type { PlanPrice, PolarConfig } from "./polar-client.js";

/** How long a price read from Polar is shown before it is read again. */
const PRICE_TTL_MS = 60 * 60 * 1000;

/** After a failed read, wait this long before asking Polar again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * What pages show when Polar can't be read and no price is cached, so the
 * plan never shows without one. Checkout charges whatever Polar sells,
 * so keep this in step with the product's price.
 */
const FALLBACK_PRICE: PlanPrice = {
  productName: "Fletcher Pro",
  amount: 1000,
  currency: "usd",
  interval: "month",
};

interface CachedPrice {
  readonly price: Option.Option<PlanPrice>;
  readonly expiresAt: number;
}

// Per isolate, so most page views never reach Polar. Keyed by server and
// product so a configuration change is a miss rather than a stale price.
const cache = new Map<string, CachedPrice>();

/**
 * The paid plan's price for pages to show. Never fails: when Polar can't
 * be read, the last known price is kept, or pages fall back to
 * `FALLBACK_PRICE`.
 */
export const cachedPlanPrice = (config: PolarConfig) =>
  Effect.gen(function* () {
    const key = `${config.server}:${config.productId}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = Option.fromNullable(cache.get(key));

    if (Option.isSome(cached) && cached.value.expiresAt > now) {
      return cached.value.price;
    }

    const polar = yield* PolarClient;

    return yield* polar.getPlanPrice.pipe(
      Effect.tap((price) =>
        Effect.sync(() =>
          cache.set(key, { price, expiresAt: now + PRICE_TTL_MS }),
        ),
      ),
      Effect.catchTag("PolarRequestError", (error) =>
        Effect.gen(function* () {
          yield* logError("polar_request_failed", {
            operation: error.operation,
            status: error.status ?? "none",
          });

          const price = Option.some(
            Option.flatMap(cached, (stale) => stale.price).pipe(
              Option.getOrElse(() => FALLBACK_PRICE),
            ),
          );

          cache.set(key, { price, expiresAt: now + RETRY_AFTER_MS });

          return price;
        }),
      ),
    );
  });

/** Drops every cached price. For tests, which share one isolate. */
export const forgetPlanPrices = () => {
  cache.clear();
};

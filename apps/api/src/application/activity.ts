import { Clock, Effect, Inspectable } from "effect";
import { UserRepository } from "@not-quite-my-tempo/db";

import { logError, logInfo } from "../logging.js";

// How long a user's active days are kept: a year of weekly and returning
// user counts, plus a month to compare against.
export const ACTIVE_DAY_RETENTION_DAYS = 400;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** A UTC calendar date, e.g. 2026-10-20. */
const utcDay = (millis: number) => new Date(millis).toISOString().slice(0, 10);

/**
 * Notes that the user opened a signed-in page today. It only feeds usage
 * counts, so a failure is logged and the page still loads.
 */
export const recordActiveDay = (userId: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      UserRepository.recordActiveDay(userId, utcDay(now)),
    ),
    Effect.catchAll((error) =>
      logError("active_day_record_failed", {
        userId,
        error: Inspectable.toStringUnknown(error.cause),
      }),
    ),
  );

/** Forgets active days older than the retention window. */
export const pruneActiveDays = Clock.currentTimeMillis.pipe(
  Effect.map((now) => utcDay(now - ACTIVE_DAY_RETENTION_DAYS * DAY_MILLIS)),
  Effect.tap((before) => UserRepository.pruneActiveDaysBefore(before)),
  Effect.flatMap((before) => logInfo("active_days_pruned", { before })),
);

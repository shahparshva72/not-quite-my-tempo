import { Effect } from "effect";

type LogFields = Record<string, string | number | boolean | undefined>;

export const logInfo = (event: string, fields: LogFields) =>
  Effect.logInfo(event).pipe(Effect.annotateLogs(fields));

export const logError = (event: string, fields: LogFields) =>
  Effect.logError(event).pipe(Effect.annotateLogs(fields));

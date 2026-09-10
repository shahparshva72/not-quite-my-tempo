import { Effect } from "effect";

export interface HealthStatus {
  readonly status: "ok";
}

export interface ServiceInfo {
  readonly name: string;
  readonly health: Effect.Effect<HealthStatus>;
}

export const makeServiceInfo = (name: string): ServiceInfo => ({
  name,
  health: Effect.succeed({ status: "ok" }),
});

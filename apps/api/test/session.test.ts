import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { createSession, verifySession } from "../src/auth/session";

const SECRET = "session-secret";

describe("session cookies", () => {
  it("round-trips a signed session", async () => {
    const cookie = await Effect.runPromise(
      createSession(SECRET, "neiman", [1001, 2002]),
    );

    const session = await Effect.runPromise(verifySession(SECRET, cookie));

    expect(Option.getOrNull(session)).toMatchObject({
      login: "neiman",
      installationIds: [1001, 2002],
    });
  });

  it("rejects a tampered payload", async () => {
    const cookie = await Effect.runPromise(
      createSession(SECRET, "neiman", [1001]),
    );

    const [payload, signature] = cookie.split(".");
    const forged = `${payload}x.${signature}`;

    const session = await Effect.runPromise(verifySession(SECRET, forged));

    expect(Option.isNone(session)).toBe(true);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await Effect.runPromise(
      createSession("other-secret", "neiman", [1001]),
    );

    const session = await Effect.runPromise(verifySession(SECRET, cookie));

    expect(Option.isNone(session)).toBe(true);
  });

  it("rejects missing values and missing secrets", async () => {
    const cookie = await Effect.runPromise(
      createSession(SECRET, "neiman", [1001]),
    );

    expect(
      Option.isNone(await Effect.runPromise(verifySession(SECRET, undefined))),
    ).toBe(true);
    expect(
      Option.isNone(await Effect.runPromise(verifySession(undefined, cookie))),
    ).toBe(true);
    expect(
      Option.isNone(await Effect.runPromise(verifySession("", cookie))),
    ).toBe(true);
    expect(
      Option.isNone(
        await Effect.runPromise(verifySession(SECRET, "not-a-cookie")),
      ),
    ).toBe(true);
  });
});

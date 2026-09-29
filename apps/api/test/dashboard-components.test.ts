import { describe, expect, it } from "vitest";

import {
  failureReason,
  relativeTime,
  reviewOutcome,
  triggerLabel,
} from "../src/dashboard/components";
import type { HtmlContent } from "../src/dashboard/components";

const now = new Date("2026-09-28T12:00:00Z");

const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

const render = async (content: HtmlContent) => String(await content);

describe("relativeTime", () => {
  it("counts minutes, hours, and days, then falls back to the date", async () => {
    expect(await render(relativeTime(minutesAgo(0), now))).toContain(
      ">just now<",
    );
    expect(await render(relativeTime(minutesAgo(1), now))).toContain(
      ">1 minute ago<",
    );
    expect(await render(relativeTime(minutesAgo(125), now))).toContain(
      ">2 hours ago<",
    );
    expect(await render(relativeTime(minutesAgo(60 * 24 * 3), now))).toContain(
      ">3 days ago<",
    );
    expect(
      await render(relativeTime(new Date("2026-07-01T09:30:00Z"), now)),
    ).toContain(">2026-07-01<");
  });

  it("keeps the exact time machine-readable", async () => {
    expect(await render(relativeTime(minutesAgo(5), now))).toContain(
      'datetime="2026-09-28T11:55:00.000Z"',
    );
  });
});

describe("review wording", () => {
  it("names failures in plain words, with a fallback for unknown codes", () => {
    expect(failureReason("gemini_error")).toBe(
      "the Gemini API didn't return a review",
    );
    expect(failureReason("something_new")).toBe(
      "an unexpected error on our side",
    );
    expect(failureReason(null)).toBe("an unexpected error on our side");
  });

  it("labels triggers the way a user thinks of them", () => {
    expect(triggerLabel("synchronize")).toBe("New push");
    expect(triggerLabel("manual")).toBe("Asked again");
  });

  it("marks a completed review by its loudest finding and counts the rest", async () => {
    const outcome = reviewOutcome(
      { status: "completed", model: "gemini-3.8-flash", errorCode: null },
      { critical: 1, warning: 2, suggestion: 0 },
    );

    expect(await render(outcome.mark)).toContain("dyn-critical");
    expect(await render(outcome.text)).toContain("1 critical, 2 warnings");
  });

  it("does not mark reviews that have not finished", async () => {
    const outcome = reviewOutcome(
      { status: "running", model: null, errorCode: null },
      { critical: 1, warning: 0, suggestion: 0 },
    );

    expect(await render(outcome.mark)).not.toContain("dyn");
    expect(await render(outcome.text)).toContain("Reviewing now");
  });
});

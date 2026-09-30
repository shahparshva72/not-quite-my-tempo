import { describe, expect, it } from "vitest";

import {
  buildReviewSummaryBody,
  verdictHeading,
} from "../src/application/review-presentation";

describe("verdictHeading", () => {
  it("keeps the standard headings", () => {
    expect(verdictHeading("not_my_tempo", "standard")).toBe(
      "🥁 Not quite my tempo.",
    );
    expect(verdictHeading("good_job", "standard")).toBe("🥁 ...Good job.");
  });

  it("never says good job in the ruthless tone", () => {
    expect(verdictHeading("not_my_tempo", "ruthless")).toBe(
      "🥁 Not. Quite. My. Tempo.",
    );
    expect(verdictHeading("almost", "ruthless")).toBe(
      "🥁 Were you rushing or were you dragging?",
    );
    expect(verdictHeading("good_job", "ruthless")).toBe("🥁 ...Acceptable.");
  });
});

describe("buildReviewSummaryBody", () => {
  it("heads the summary with the tone's verdict line", () => {
    const body = buildReviewSummaryBody(
      { verdict: "good_job", summary: "Fine.", findings: [] },
      [],
      [],
      "ruthless",
    );

    expect(body).toContain("### 🥁 ...Acceptable.");
    expect(body).not.toContain("Good job");
  });
});

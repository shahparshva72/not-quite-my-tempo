import { describe, expect, it } from "vitest";

import {
  buildReviewSummaryBody,
  defangModelMarkdown,
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

describe("defangModelMarkdown", () => {
  it("shows where links go and drops images", () => {
    expect(
      defangModelMarkdown(
        "See [the docs](https://evil.test/login) ![pixel](https://evil.test/p.png)",
      ),
    ).toBe("See the docs (https://evil.test/login) pixel");
  });

  it("drops link and image HTML and neutralizes link definitions", () => {
    expect(
      defangModelMarkdown(
        '<a href="https://evil.test">click</a><img src="https://evil.test/p.png">\n[ref]: https://evil.test',
      ),
    ).toBe("click\n\\[ref]: https://evil.test");
  });

  it("leaves code spans and fences as written", () => {
    const text =
      "Use `fns[i](x)` here.\n```ts\nconst link = [a](b);\n```\nand [x](https://y.test)";

    expect(defangModelMarkdown(text)).toBe(
      "Use `fns[i](x)` here.\n```ts\nconst link = [a](b);\n```\nand x (https://y.test)",
    );
  });

  it("applies to the posted summary", () => {
    const body = buildReviewSummaryBody(
      {
        verdict: "almost",
        summary: "Read [this](https://evil.test).",
        findings: [],
      },
      [],
      [],
      "standard",
    );

    expect(body).toContain("Read this (https://evil.test).");
  });
});

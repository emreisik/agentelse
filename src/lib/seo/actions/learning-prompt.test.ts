import { describe, expect, it } from "vitest";

import { seoLearningsPromptLine } from "./learning-prompt";

// Bu dosyanın kanıtladığı: öğrenme yoksa istem değişmez; en çok beş satır,
// her biri 240 karakterle sınırlı ve "- " önekli.

describe("seoLearningsPromptLine", () => {
  it("is null without usable learnings", () => {
    expect(seoLearningsPromptLine({})).toBeNull();
    expect(seoLearningsPromptLine({ seoLearnings: [] })).toBeNull();
    expect(seoLearningsPromptLine({ seoLearnings: "text" })).toBeNull();
    expect(seoLearningsPromptLine({ seoLearnings: [1, null, {}] })).toBeNull();
    expect(seoLearningsPromptLine({ seoLearnings: ["", "   "] })).toBeNull();
  });

  it("prints the header and prefixed lines", () => {
    const line = seoLearningsPromptLine({ seoLearnings: ["First", "Second"] });
    expect(line).toBe(
      "PAST RESULTS on this site (prefer what worked):\n- First\n- Second",
    );
  });

  it("keeps at most five lines", () => {
    const line = seoLearningsPromptLine({
      seoLearnings: Array.from({ length: 9 }, (_, i) => `Item ${i}`),
    });
    expect(line?.split("\n")).toHaveLength(6);
    expect(line).not.toContain("Item 5");
  });

  it("trims each learning to 240 characters and skips junk items", () => {
    const line = seoLearningsPromptLine({
      seoLearnings: ["x".repeat(400), 7, "ok"],
    });
    const lines = line?.split("\n") ?? [];
    expect(lines[1]).toBe(`- ${"x".repeat(240)}`);
    expect(lines[2]).toBe("- ok");
  });

  it("collapses whitespace inside a learning", () => {
    expect(seoLearningsPromptLine({ seoLearnings: ["a\n\n  b"] })).toContain("- a b");
  });
});

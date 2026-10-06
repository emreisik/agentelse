import { describe, expect, it } from "vitest";

import { seoOpportunityPromptParts } from "./opportunity-prompt";

// Bu dosyanın kanıtladığı: fırsat yokken parça da yoktur (istem bayt bayt
// aynı kalır); varken kural ve satır tam metinleriyle döner.

describe("seoOpportunityPromptParts", () => {
  it("returns null for an absent, non-array or empty opportunities field", () => {
    expect(seoOpportunityPromptParts({})).toBeNull();
    expect(seoOpportunityPromptParts({ opportunities: "x" })).toBeNull();
    expect(seoOpportunityPromptParts({ opportunities: { a: 1 } })).toBeNull();
    expect(seoOpportunityPromptParts({ opportunities: null })).toBeNull();
    expect(seoOpportunityPromptParts({ opportunities: [] })).toBeNull();
  });

  it("returns the exact rule and line otherwise", () => {
    const opportunities = [["running shoes", "Close to page one", 1200, 8.4]];
    expect(seoOpportunityPromptParts({ opportunities })).toEqual({
      rule: "Prefer the evidence-backed opportunities first, then the quick wins; keep the keyword exactly as given.",
      line: `Evidence-backed opportunities from the site's search data (keyword, why, impressions in 4 weeks, position): [["running shoes","Close to page one",1200,8.4]]`,
    });
  });
});

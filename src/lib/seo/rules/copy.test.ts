import { describe, expect, it } from "vitest";

import { SEO_RULE_KEYS } from "@/lib/seo/opportunity-types";

import {
  displayKeyword,
  formatCount,
  formatPosition,
  KEYWORD_DISPLAY_MAX,
  SEO_RULE_LABEL,
  SEO_SIGNAL_TEXT,
  shortText,
  strikingDistanceCopy,
} from "./copy";
import { SEO_RULES } from "./index";
import { draftInvariantErrors, RULE_SCENARIOS } from "./test-support";

describe("SEO_SIGNAL_TEXT", () => {
  it("covers exactly the Signal rules", () => {
    expect(Object.keys(SEO_SIGNAL_TEXT).sort()).toEqual(
      [
        "SO10_BRAND_DEMAND",
        "SO13_INTERNATIONAL",
        "SO3_CONTENT_DECAY",
        "SO6_RISING_QUERY",
        "SO7_LOST",
        "SO9_PAGE_GROUP_TREND",
      ].sort(),
    );
  });

  it("is generic: no digits, slashes, links or quotes", () => {
    for (const entry of Object.values(SEO_SIGNAL_TEXT)) {
      for (const text of [entry!.title, entry!.summary]) {
        expect(text).not.toMatch(/\d/);
        expect(text).not.toContain("/");
        expect(text.toLowerCase()).not.toContain("http");
        expect(text).not.toMatch(/["'“”‘’]/);
      }
    }
  });
});

describe("SEO_RULE_LABEL", () => {
  it("labels every rule without digits", () => {
    expect(Object.keys(SEO_RULE_LABEL).sort()).toEqual(
      [...SEO_RULE_KEYS].sort(),
    );
    for (const label of Object.values(SEO_RULE_LABEL)) {
      expect(label).not.toMatch(/\d/);
    }
  });
});

describe("formatting", () => {
  it("groups counts and rounds positions", () => {
    expect(formatCount(12345.6)).toBe("12,346");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatPosition(7.25)).toBe("7.3");
    expect(formatPosition(4)).toBe("4.0");
  });

  it("shortens long keywords with an ellipsis", () => {
    const long = "a".repeat(80);
    expect(Array.from(displayKeyword(long))).toHaveLength(KEYWORD_DISPLAY_MAX);
    expect(displayKeyword(long).endsWith("…")).toBe(true);
    expect(shortText("short", 10)).toBe("short");
  });

  it("keeps titles and summaries within their limits", () => {
    const copy = strikingDistanceCopy({
      path: `/${"x".repeat(200)}`,
      queries: 1_234_567,
      impressions: 98_765_432,
      gain: 1_234_567,
    });
    expect(Array.from(copy.title).length).toBeLessThanOrEqual(90);
    expect(Array.from(copy.summary).length).toBeLessThanOrEqual(280);
  });
});

describe("rule copy invariants", () => {
  for (const rule of SEO_RULES) {
    it(`${rule.key} cites only its metrics, keyword and primary path`, () => {
      const snapshot = RULE_SCENARIOS[rule.key]();
      const result = rule.evaluate(snapshot);
      expect(result.evaluable).toBe(true);
      if (!result.evaluable) return;
      expect(result.drafts.length).toBeGreaterThan(0);
      for (const draft of result.drafts) {
        expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
        expect(draft.title).not.toMatch(/faq|howto/i);
      }
    });
  }
});

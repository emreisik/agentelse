import { describe, expect, it } from "vitest";

import {
  SEO_DISMISS_REASONS,
  SEO_FINDING_STATUSES,
  SEO_RULE_KEYS,
  isSeoRuleKey,
} from "./opportunity-types";

describe("isSeoRuleKey", () => {
  it("accepts every rule key and nothing else", () => {
    expect(SEO_RULE_KEYS).toHaveLength(16);
    for (const key of SEO_RULE_KEYS) expect(isSeoRuleKey(key)).toBe(true);
    for (const value of ["SO17_X", "so1_striking_distance", "", null, 1, {}]) {
      expect(isSeoRuleKey(value)).toBe(false);
    }
  });

  it("keeps the stored enums stable", () => {
    expect(SEO_FINDING_STATUSES).toEqual([
      "OPEN",
      "ACCEPTED",
      "DISMISSED",
      "DONE",
      "EVALUATED",
      "EXPIRED",
      "SUPERSEDED",
      "RESOLVED",
    ]);
    expect(SEO_DISMISS_REASONS).toEqual([
      "not_relevant",
      "already_done",
      "wrong_data",
      "not_now",
    ]);
  });
});

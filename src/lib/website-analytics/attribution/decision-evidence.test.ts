import { describe, expect, it } from "vitest";

import { withGaEvidence } from "./decision-evidence";

describe("withGaEvidence", () => {
  const evidence = { window: { from: "2026-09-01" }, cpa: 12 };

  it("returns the very same evidence object when GA4 has nothing to add", () => {
    expect(withGaEvidence(evidence, null)).toBe(evidence);
  });

  it("merges the ga4_* fields without touching the rule's own keys", () => {
    const merged = withGaEvidence(evidence, {
      ga4_source: "GA4",
      ga4_sessions: 120,
    });
    expect(merged).toEqual({ ...evidence, ga4_source: "GA4", ga4_sessions: 120 });
    expect(evidence).not.toHaveProperty("ga4_source");
  });
});

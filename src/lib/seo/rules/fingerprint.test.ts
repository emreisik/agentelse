import { describe, expect, it } from "vitest";

import {
  monthlyPeriodKey,
  seoFindingFingerprint,
  weeklyPeriodKey,
} from "./fingerprint";
import { snapshotFixture } from "./test-support";

describe("finding fingerprints", () => {
  it("builds weekly and monthly period keys", () => {
    expect(weeklyPeriodKey(snapshotFixture())).toBe("W:2026-09-27");
    expect(monthlyPeriodKey("2026-08-01")).toBe("M:2026-08-01");
  });

  const base = {
    linkId: "link-1",
    ruleKey: "SO1_STRIKING_DISTANCE" as const,
    subject: "page:p1",
    periodKey: "W:2026-09-27",
  };

  it("is stable within a week and changes across weeks", () => {
    const fp = seoFindingFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(seoFindingFingerprint({ ...base })).toBe(fp);
    expect(
      seoFindingFingerprint({ ...base, periodKey: "W:2026-10-04" }),
    ).not.toBe(fp);
  });

  it("includes the link, rule and subject", () => {
    const fp = seoFindingFingerprint(base);
    expect(seoFindingFingerprint({ ...base, linkId: "link-2" })).not.toBe(fp);
    expect(seoFindingFingerprint({ ...base, ruleKey: "SO2_CTR_GAP" })).not.toBe(
      fp,
    );
    expect(seoFindingFingerprint({ ...base, subject: "page:p2" })).not.toBe(fp);
  });
});

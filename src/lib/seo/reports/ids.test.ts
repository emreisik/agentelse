import { describe, expect, it } from "vitest";

import { periodKeyOf, seoReportCommandId, seoWorkId } from "./ids";
import { SEO_REPORT_KINDS } from "./types";

describe("seoWorkId", () => {
  it("is one deterministic Work per project", () => {
    expect(seoWorkId("proj_1")).toBe("wkseo_proj_1");
  });
});

describe("periodKeyOf", () => {
  it("prefixes by kind", () => {
    expect(periodKeyOf("PULSE", "2026-10-05")).toBe("D:2026-10-05");
    expect(periodKeyOf("WEEKLY", "2026-09-28")).toBe("W:2026-09-28");
    expect(periodKeyOf("MONTHLY", "2026-09-01")).toBe("M:2026-09");
    expect(periodKeyOf("ROADMAP", "2026-10-01")).toBe("M:2026-10");
  });
});

describe("seoReportCommandId", () => {
  it("is keyed by the link id and the period", () => {
    expect(
      seoReportCommandId("WEEKLY", "link_a", periodKeyOf("WEEKLY", "2026-09-28")),
    ).toBe("seoweekly_link_a_2026-09-28");
    expect(
      seoReportCommandId("MONTHLY", "link_a", periodKeyOf("MONTHLY", "2026-09-01")),
    ).toBe("seomonthly_link_a_2026-09");
    expect(
      seoReportCommandId("PULSE", "link_a", periodKeyOf("PULSE", "2026-10-05")),
    ).toBe("seopulse_link_a_2026-10-05");
    expect(
      seoReportCommandId("ROADMAP", "link_a", periodKeyOf("ROADMAP", "2026-10-01")),
    ).toBe("seoroadmap_link_a_2026-10");
  });

  it("differs for two links of the same project and period", () => {
    const period = periodKeyOf("WEEKLY", "2026-09-28");
    expect(seoReportCommandId("WEEKLY", "link_mock", period)).not.toBe(
      seoReportCommandId("WEEKLY", "link_live", period),
    );
  });

  it("differs between kinds for the same period", () => {
    const ids = SEO_REPORT_KINDS.map((kind) =>
      seoReportCommandId(kind, "link_a", "M:2026-09"),
    );
    expect(new Set(ids).size).toBe(SEO_REPORT_KINDS.length);
  });
});

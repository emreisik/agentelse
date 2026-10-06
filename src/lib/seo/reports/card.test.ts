import { describe, expect, it } from "vitest";

import { isSeoReportCard, seoReportCard } from "./card";

describe("seoReportCard", () => {
  it("is a pointer with the kind's title and no Google numbers", () => {
    const card = seoReportCard({
      reportId: "rep_1",
      kind: "WEEKLY",
      periodLabel: "Sep 28 – Oct 4",
    });
    expect(card).toEqual({
      kind: "seo-report",
      reportId: "rep_1",
      reportKind: "WEEKLY",
      title: "Weekly SEO report",
      periodLabel: "Sep 28 – Oct 4",
    });
    expect(isSeoReportCard(card)).toBe(true);
  });
});

describe("isSeoReportCard", () => {
  const valid = {
    kind: "seo-report",
    reportId: "rep_1",
    reportKind: "MONTHLY",
    title: "Monthly SEO report",
    periodLabel: "September 2026",
  };

  it("accepts a valid card", () => {
    expect(isSeoReportCard(valid)).toBe(true);
  });

  it("rejects a wrong kind, a missing reportId or a bad reportKind", () => {
    expect(isSeoReportCard({ ...valid, kind: "ga-report" })).toBe(false);
    expect(isSeoReportCard({ ...valid, reportId: undefined })).toBe(false);
    expect(isSeoReportCard({ ...valid, reportId: "" })).toBe(false);
    expect(isSeoReportCard({ ...valid, reportKind: "DAILY" })).toBe(false);
    expect(isSeoReportCard({ ...valid, title: 4 })).toBe(false);
    expect(isSeoReportCard({ ...valid, periodLabel: null })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isSeoReportCard(null)).toBe(false);
    expect(isSeoReportCard("seo-report")).toBe(false);
    expect(isSeoReportCard([valid])).toBe(false);
  });
});

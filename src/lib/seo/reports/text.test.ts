import { describe, expect, it } from "vitest";

import {
  DIAGNOSE_CAUSE,
  DIAGNOSE_STEP_QUESTION,
  KPI_LABEL,
  NARRATIVE_NOTE,
  SEO_REPORT_TITLE,
  TABLE_TITLE,
  changeText,
  changeTextFromRatio,
  dayLabel,
  kpiValueText,
  monthLabel,
  periodLabel,
  seoReportReply,
  seoWorkSummary,
} from "./text";
import { SEO_REPORT_KINDS, type SeoReportKpi } from "./types";

describe("labels", () => {
  it("has the contract titles", () => {
    expect(SEO_REPORT_TITLE).toEqual({
      PULSE: "Search pulse",
      WEEKLY: "Weekly SEO report",
      MONTHLY: "Monthly SEO report",
      ROADMAP: "SEO roadmap",
    });
    expect(KPI_LABEL.position).toBe("Avg. position");
    expect(TABLE_TITLE.rising_queries).toBe("Rising searches");
    expect(Object.keys(DIAGNOSE_STEP_QUESTION)).toHaveLength(8);
    expect(Object.keys(DIAGNOSE_CAUSE)).toHaveLength(8);
    expect(DIAGNOSE_CAUSE.indexing).toBe("pages dropping out of Google's index");
  });

  it("writes the canonical narrative notes", () => {
    expect(NARRATIVE_NOTE.mock).toBe("AI summary isn't available with sample data.");
    expect(NARRATIVE_NOTE.budget).toBe(
      "The AI summary was skipped today because the daily AI limit was reached. The numbers are complete.",
    );
    expect(NARRATIVE_NOTE.failed).toBe("The AI summary couldn't be written this time.");
    expect(NARRATIVE_NOTE.dropped).toBe(
      "The AI summary was left out because it didn't match the numbers.",
    );
  });
});

describe("dates", () => {
  it("writes short day and month labels", () => {
    expect(dayLabel("2026-10-03")).toBe("Oct 3");
    expect(monthLabel("2026-09-01")).toBe("September 2026");
  });

  it("writes a period within a year", () => {
    expect(periodLabel("2026-09-29", "2026-10-05")).toBe("Sep 29 – Oct 5");
    expect(periodLabel("2026-10-01", "2026-10-07")).toBe("Oct 1 – Oct 7");
  });

  it("adds the years when the period crosses one", () => {
    expect(periodLabel("2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 – Jan 4, 2026",
    );
  });

  it("writes one day as a day label", () => {
    expect(periodLabel("2026-10-03", "2026-10-03")).toBe("Oct 3");
  });
});

describe("seoReportReply", () => {
  it("is built from the kind and the label only", () => {
    const label = periodLabel("2026-09-28", "2026-10-04");
    const reply = seoReportReply("WEEKLY", label);
    expect(reply).toBe("Weekly SEO report for Sep 28 – Oct 4.");
    // Etiketteki tarih dışında rakam yok.
    expect(reply.replace(label, "")).not.toMatch(/\d/);
  });

  it("covers every kind", () => {
    for (const kind of SEO_REPORT_KINDS) {
      expect(seoReportReply(kind, "Oct 5")).toBe(
        `${SEO_REPORT_TITLE[kind]} for Oct 5.`,
      );
      expect(seoWorkSummary(kind)).toBe(SEO_REPORT_TITLE[kind]);
    }
  });
});

describe("changeText", () => {
  it("takes percent units and writes a Unicode minus", () => {
    expect(changeText(-12.3)).toBe("−12%");
    expect(changeText(12.3)).toBe("+12%");
    expect(changeText(-5)).toBe("−5%");
    expect(changeText(0)).toBe("0%");
    expect(changeText(0.2)).toBe("0%");
    expect(changeText(null)).toBe("—");
  });

  it("takes a fraction in changeTextFromRatio", () => {
    expect(changeTextFromRatio(-0.3)).toBe("−30%");
    expect(changeTextFromRatio(0.123)).toBe("+12%");
    expect(changeTextFromRatio(null)).toBe("—");
  });
});

describe("kpiValueText", () => {
  const base = {
    key: "clicks",
    label: "Clicks",
    previous: null,
    yearAgo: null,
    lowerIsBetter: false,
  } as const;

  it("formats by kind and dashes null", () => {
    const count: SeoReportKpi = { ...base, value: 12345, format: "count" };
    const percent: SeoReportKpi = { ...base, value: 2.35, format: "percent" };
    const position: SeoReportKpi = { ...base, value: 8.1, format: "position" };
    expect(kpiValueText(count)).toBe("12,345");
    expect(kpiValueText(percent)).toBe("2.35%");
    expect(kpiValueText(position)).toBe("8.1");
    expect(kpiValueText(count, "previous")).toBe("—");
    expect(kpiValueText({ ...count, yearAgo: 900 }, "yearAgo")).toBe("900");
  });
});

import { describe, expect, it } from "vitest";

import {
  WEBSITE_REPORT_COPY,
  dayLabel,
  monthLabel,
  rangeLabel,
  reportTitle,
  weekdayDayLabel,
  workSummaryOf,
} from "./copy";
import { WEBSITE_REPORT_VARIANTS } from "./types";

// Bu dosyanın kanıtladığı: tarih etiketleri UTC günü üzerinden İngilizce
// biçimlenir, başlıklar sözleşmedeki gibidir, iş özetinde rakam yoktur ve
// bütün sabit metinler dolu ve ünlemsizdir.

describe("date labels", () => {
  it("formats a day", () => {
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
    expect(dayLabel("2026-01-31")).toBe("Jan 31");
    expect(weekdayDayLabel("2026-10-05")).toBe("Mon, Oct 5");
  });

  it("formats a range within one year", () => {
    expect(rangeLabel("2026-09-28", "2026-10-04")).toBe("Sep 28 – Oct 4");
  });

  it("adds the year to both sides across years", () => {
    expect(rangeLabel("2026-12-28", "2027-01-03")).toBe(
      "Dec 28, 2026 – Jan 3, 2027",
    );
  });

  it("formats a month", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
  });

  it("returns the input for a malformed day instead of throwing", () => {
    expect(dayLabel("nope")).toBe("nope");
  });
});

describe("reportTitle", () => {
  it("builds a title per variant", () => {
    expect(reportTitle("pulse", { day: "2026-10-05" })).toBe(
      "Website pulse · Mon, Oct 5",
    );
    expect(
      reportTitle("weekly", { from: "2026-09-28", to: "2026-10-04" }),
    ).toBe("Weekly website report · Sep 28 – Oct 4");
    expect(reportTitle("monthly", { month: "2026-09" })).toBe(
      "Monthly website report · September 2026",
    );
    expect(reportTitle("plan", { month: "2026-10" })).toBe(
      "Next month plan · October 2026",
    );
    expect(reportTitle("alert", { alertTitle: "Tag is missing" })).toBe(
      "Tracking alert: Tag is missing",
    );
  });
});

describe("workSummaryOf", () => {
  it("has no digits for any variant", () => {
    for (const variant of WEBSITE_REPORT_VARIANTS) {
      const summary = workSummaryOf(variant);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toMatch(/\d/);
    }
    expect(workSummaryOf("weekly")).toBe("Weekly website report");
    expect(workSummaryOf("alert")).toBe("Tracking alert");
  });
});

describe("WEBSITE_REPORT_COPY", () => {
  it("holds non-empty strings without exclamation marks", () => {
    const entries = Object.entries(WEBSITE_REPORT_COPY);
    expect(entries).toHaveLength(21);
    for (const [, value] of entries) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      expect(value).not.toContain("!");
    }
  });

  it("keeps the timezone placeholder in the source line", () => {
    expect(WEBSITE_REPORT_COPY.sourceLine).toContain("{tz}");
  });
});

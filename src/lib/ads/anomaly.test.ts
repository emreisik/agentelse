import { describe, expect, it } from "vitest";

import { anomalyTitle, metricAnomalies, type AnomalyDay } from "./anomaly";

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TARGET = "2026-10-05"; // Pazartesi

// 28 günlük geçmiş: CPM ~10 (küçük gürültü), CTR ~%1, CPA ~500.
function history(
  shape: (date: string, index: number) => Partial<AnomalyDay> = () => ({}),
): AnomalyDay[] {
  const days: AnomalyDay[] = [];
  for (let offset = 28; offset >= 1; offset -= 1) {
    const date = shift(TARGET, -offset);
    const wobble = (offset % 3) - 1; // -1, 0, 1
    days.push({
      date,
      spendMinor: 10_000 + wobble * 400,
      impressions: 1000,
      linkClicks: 10 + wobble,
      results: 20 + wobble,
      ...shape(date, offset),
    });
  }
  return days;
}

describe("metricAnomalies", () => {
  it("flags a cost per 1,000 views far above its baseline", () => {
    const days = [...history(), { date: TARGET, spendMinor: 30_000, impressions: 1000, linkClicks: 10, results: 20 }];
    const found = metricAnomalies(days, TARGET);
    expect(found.map((anomaly) => anomaly.metric)).toContain("CPM");
    const cpm = found.find((anomaly) => anomaly.metric === "CPM")!;
    expect(cpm.z).toBeGreaterThanOrEqual(3);
    expect(anomalyTitle(cpm)).toMatch(/^Cost per 1,000 views jumped \d+% yesterday$/);
  });

  it("stays quiet on an ordinary day", () => {
    const days = [...history(), { date: TARGET, spendMinor: 10_000, impressions: 1000, linkClicks: 10, results: 20 }];
    expect(metricAnomalies(days, TARGET)).toEqual([]);
  });

  it("does not call a normal weekend pattern an anomaly", () => {
    const weekend = (date: string) => {
      const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return day === 0 || day === 6;
    };
    const days = history((date) => (weekend(date) ? { spendMinor: 20_000 } : {}));
    const sunday = shift(TARGET, -1);
    // Pazar günü hedef: hafta sonu iki katı her zamanki gibi.
    const withoutSunday = days.filter((day) => day.date !== sunday);
    const target = { date: sunday, spendMinor: 20_000, impressions: 1000, linkClicks: 10, results: 20 };
    expect(
      metricAnomalies([...withoutSunday, target], sunday).filter((a) => a.metric === "CPM"),
    ).toEqual([]);
  });

  it("only reports the bad direction and needs enough volume", () => {
    const better = [...history(), { date: TARGET, spendMinor: 2_000, impressions: 1000, linkClicks: 40, results: 80 }];
    expect(metricAnomalies(better, TARGET)).toEqual([]);
    const ctrDrop = [...history(), { date: TARGET, spendMinor: 10_000, impressions: 1000, linkClicks: 0, results: 20 }];
    expect(metricAnomalies(ctrDrop, TARGET).map((a) => a.metric)).toEqual(["LINK_CTR"]);
    const tiny = [...history(), { date: TARGET, spendMinor: 30_000, impressions: 100, linkClicks: 0, results: 1 }];
    expect(metricAnomalies(tiny, TARGET)).toEqual([]);
  });

  it("needs ten days of baseline", () => {
    const short = history().slice(-5);
    expect(
      metricAnomalies([...short, { date: TARGET, spendMinor: 90_000, impressions: 1000, linkClicks: 10, results: 20 }], TARGET),
    ).toEqual([]);
  });
});

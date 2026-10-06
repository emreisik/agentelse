import { describe, expect, it } from "vitest";

import {
  changePercent,
  isWebsitePeriod,
  resolveWebsitePeriod,
} from "./periods";

describe("resolveWebsitePeriod", () => {
  it("ends rolling periods yesterday and compares with the one before", () => {
    expect(resolveWebsitePeriod("7d", "2026-10-06")).toMatchObject({
      from: "2026-09-29",
      to: "2026-10-05",
      days: 7,
      previous: { from: "2026-09-22", to: "2026-09-28" },
      rollingWindow: 7,
    });
  });

  it("compares this month with the same days of last month", () => {
    expect(resolveWebsitePeriod("this_month", "2026-10-06")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-05",
      days: 5,
      previous: { from: "2026-09-01", to: "2026-09-05" },
      rollingWindow: null,
    });
    // Ayın ilk günü henüz tamamlanmış gün yok.
    expect(resolveWebsitePeriod("this_month", "2026-10-01").days).toBe(0);
    // 31 Mart: geçen ay Şubat 28 günle sınırlı.
    expect(resolveWebsitePeriod("this_month", "2026-03-31").previous).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("takes last month whole", () => {
    expect(resolveWebsitePeriod("last_month", "2026-01-15")).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-31",
      days: 31,
      previous: { from: "2025-11-01", to: "2025-11-30" },
    });
  });

  it("knows its keys and computes changes honestly", () => {
    expect(isWebsitePeriod("90d")).toBe(true);
    expect(isWebsitePeriod("year")).toBe(false);
    expect(changePercent(120, 100)).toBeCloseTo(20);
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(null, 10)).toBeNull();
  });
});

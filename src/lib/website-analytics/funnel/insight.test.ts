import { describe, expect, it } from "vitest";

import { FUNNEL_NOT_ENOUGH, formatFunnelPercent, funnelInsight } from "./insight";
import type { FunnelResult } from "./types";

// Bu dosyanın kanıtladığı: ilk adımda 30'dan az kullanıcıda sabit cümle; en
// büyük BAĞIL düşüş seçimi (eşitlikte ilk); genel yüzde; adlar kullanıcının
// tanımından gelir (Google'ın adı değil).

const steps = [{ name: "Visit" }, { name: "Form" }, { name: "Lead" }];

function result(users: number[], names = ["x", "y", "z"]): FunnelResult {
  return {
    through: "2026-10-06",
    steps: users.map((count, index) => ({
      name: names[index] ?? "?",
      users: count,
      completionRate: null,
      abandonments: null,
      abandonmentRate: null,
    })),
  };
}

describe("funnelInsight", () => {
  it("says there is not enough data under 30 first-step users", () => {
    const insight = funnelInsight(steps, result([29, 10, 5]));
    expect(insight.headline).toBe(FUNNEL_NOT_ENOUGH);
    expect(insight.overall).toBeNull();
    expect(insight.biggestDrop).toBeNull();
    expect(funnelInsight(steps, result([30, 10, 5])).overall).not.toBeNull();
  });

  it("picks the biggest relative drop, not the biggest absolute one", () => {
    // 1000 -> 500 kaybı daha büyük (500) ama oran %50; 500 -> 100 %80.
    const insight = funnelInsight(steps, result([1000, 500, 100]));
    expect(insight.biggestDrop).toMatchObject({
      fromIndex: 1,
      toIndex: 2,
      lostUsers: 400,
    });
    expect(insight.biggestDrop?.dropRate).toBeCloseTo(0.8);
    expect(insight.headline).toContain('between "Form" and "Lead"');
    expect(insight.headline).toContain("80%");
  });

  it("reports the overall share and uses the definition's names", () => {
    const insight = funnelInsight(
      steps,
      result([400, 200, 100], ["GOOGLE-A", "GOOGLE-B", "GOOGLE-C"]),
    );
    expect(insight.overall).toBeCloseTo(0.25);
    expect(insight.headline).toContain(
      '25% of people who reached "Visit" went on to "Lead"',
    );
    expect(insight.headline).not.toContain("GOOGLE");
  });

  it("breaks ties in favour of the earlier step", () => {
    const insight = funnelInsight(steps, result([100, 50, 25]));
    expect(insight.biggestDrop?.fromIndex).toBe(0);
  });

  it("handles a funnel with no drop and zero users in the middle", () => {
    const flat = funnelInsight(steps, result([100, 100, 100]));
    expect(flat.biggestDrop).toBeNull();
    expect(flat.headline).toBe(
      '100% of people who reached "Visit" went on to "Lead".',
    );
    const hole = funnelInsight(steps, result([100, 0, 0]));
    expect(hole.biggestDrop).toMatchObject({ fromIndex: 0, lostUsers: 100 });
    expect(hole.overall).toBe(0);
  });
});

describe("formatFunnelPercent", () => {
  it("rounds and marks tiny shares", () => {
    expect(formatFunnelPercent(0.256)).toBe("26%");
    expect(formatFunnelPercent(0.001)).toBe("<1%");
    expect(formatFunnelPercent(0)).toBe("0%");
  });
});

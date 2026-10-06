import { describe, expect, it } from "vitest";

import { readWebsiteReportCard } from "./card";
import { WEBSITE_REPORT_COPY } from "./copy";
import {
  PLAN_SEASONAL_MAX,
  buildPlanCard,
  niceTarget,
  proposeTargets,
} from "./plan";
import { makeSlice, makeWindow } from "./test-fixtures";
import type { PlanMonthTotals, PlanReportInput } from "./types";

function month(
  key: string,
  daysInMonth: number,
  totals: Partial<Pick<PlanMonthTotals, "sessions" | "keyEvents" | "revenue">> = {},
): PlanMonthTotals {
  return {
    month: key,
    days: daysInMonth,
    daysInMonth,
    sessions: 0,
    keyEvents: 0,
    revenue: 0,
    ...totals,
  };
}

const NO_GOALS: { id: string; metricKey: "web.sessions"; targetValue: number | null }[] = [];

describe("niceTarget", () => {
  it("iki anlamlı basamağa yuvarlar", () => {
    expect(niceTarget(3287, "count")).toBe(3300);
    expect(niceTarget(12_449, "count")).toBe(12_000);
    expect(niceTarget(99_999, "count")).toBe(100_000);
    expect(niceTarget(48.7, "count")).toBe(49);
    expect(niceTarget(1234.5, "money")).toBe(1200);
    expect(niceTarget(7.46, "money")).toBe(7.5);
  });

  it("değer sıfırdan büyükse asla 0 olmaz", () => {
    expect(niceTarget(0.2, "count")).toBe(1);
    expect(niceTarget(0.001, "money")).toBe(0.01);
    expect(niceTarget(0, "count")).toBe(0);
  });
});

describe("proposeTargets", () => {
  it("tek ay varsa planNeedMonths notu verir", () => {
    const result = proposeTargets({
      month: "2026-10",
      months: [month("2026-09", 30, { sessions: 3000 })],
      goals: NO_GOALS,
    });
    expect(result).toEqual({
      proposals: [],
      note: WEBSITE_REPORT_COPY.planNeedMonths,
    });
  });

  it("3 ay x 3.000 oturum: 30 günlük ay için 3.300 önerir, aralık 3.300-3.450", () => {
    const result = proposeTargets({
      month: "2026-11",
      months: [
        month("2026-08", 31, { sessions: 3100 }),
        month("2026-09", 30, { sessions: 3000 }),
        month("2026-10", 31, { sessions: 3100 }),
      ],
      goals: NO_GOALS,
    });
    const [sessions] = result.proposals;
    expect(result.note).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(sessions?.metricKey).toBe("web.sessions");
    expect(sessions?.label).toBe("Sessions");
    expect(sessions?.format).toBe("count");
    expect(sessions?.baseline).toBe(3000);
    expect(sessions?.baselineMonths).toBe(3);
    expect(sessions?.seasonalPct).toBeNull();
    expect(sessions?.realistic).toBe(3000);
    expect(sessions?.low).toBe(3300);
    expect(sessions?.high).toBe(3450);
    expect(sessions?.suggested).toBe(3300);
    expect(sessions?.currentGoal).toBeNull();
  });

  it("mevsimsellik katsayısı 1,4 ile kenetlenir", () => {
    // Geçen yıl hedef ay (2025-11) önceki 3 aya göre 3 kat yüksek.
    const result = proposeTargets({
      month: "2026-11",
      months: [
        month("2025-08", 31, { sessions: 3100 }),
        month("2025-09", 30, { sessions: 3000 }),
        month("2025-10", 31, { sessions: 3100 }),
        month("2025-11", 30, { sessions: 9000 }),
        month("2026-08", 31, { sessions: 3100 }),
        month("2026-09", 30, { sessions: 3000 }),
        month("2026-10", 31, { sessions: 3100 }),
      ],
      goals: NO_GOALS,
    });
    const [sessions] = result.proposals;
    expect(PLAN_SEASONAL_MAX).toBe(1.4);
    expect(sessions?.seasonalPct).toBe(40);
    expect(sessions?.baseline).toBe(3000);
    expect(sessions?.realistic).toBe(4200);
    expect(sessions?.low).toBe(4620);
    expect(sessions?.suggested).toBe(4600);
  });

  it("geçen yılın verisi eksikse mevsimsellik yoktur", () => {
    const result = proposeTargets({
      month: "2026-11",
      months: [
        month("2025-11", 30, { sessions: 9000 }),
        month("2026-08", 31, { sessions: 3100 }),
        month("2026-09", 30, { sessions: 3000 }),
        month("2026-10", 31, { sessions: 3100 }),
      ],
      goals: NO_GOALS,
    });
    expect(result.proposals[0]?.seasonalPct).toBeNull();
    expect(result.proposals[0]?.baselineMonths).toBe(3);
    expect(result.proposals[0]?.realistic).toBe(3000);
  });

  it("anahtar olay tabanı 8 ise atlanır, gelir 0 ise atlanır", () => {
    const result = proposeTargets({
      month: "2026-10",
      months: [
        month("2026-07", 30, { sessions: 3000, keyEvents: 8, revenue: 0 }),
        month("2026-08", 30, { sessions: 3000, keyEvents: 8, revenue: 0 }),
        month("2026-09", 30, { sessions: 3000, keyEvents: 8, revenue: 0 }),
      ],
      goals: NO_GOALS,
    });
    expect(result.proposals.map((row) => row.metricKey)).toEqual([
      "web.sessions",
    ]);
  });

  it("sıra: oturum, anahtar olay, gelir; hiçbiri yetmezse planNoMetrics", () => {
    const rich = proposeTargets({
      month: "2026-10",
      months: [
        month("2026-08", 30, { sessions: 3000, keyEvents: 300, revenue: 1500.5 }),
        month("2026-09", 30, { sessions: 3000, keyEvents: 300, revenue: 1500.5 }),
      ],
      goals: NO_GOALS,
    });
    expect(rich.proposals.map((row) => row.metricKey)).toEqual([
      "web.sessions",
      "web.key_events",
      "web.revenue",
    ]);
    const revenue = rich.proposals[2];
    expect(revenue?.format).toBe("money");
    expect(revenue?.baseline).toBeCloseTo(1550.52, 2);

    const tiny = proposeTargets({
      month: "2026-10",
      months: [
        month("2026-08", 30, { sessions: 20 }),
        month("2026-09", 30, { sessions: 20 }),
      ],
      goals: NO_GOALS,
    });
    expect(tiny).toEqual({
      proposals: [],
      note: WEBSITE_REPORT_COPY.planNoMetrics,
    });
  });

  it("mevcut hedef eşleşir", () => {
    const result = proposeTargets({
      month: "2026-10",
      months: [
        month("2026-08", 30, { sessions: 3000 }),
        month("2026-09", 30, { sessions: 3000 }),
      ],
      goals: [{ id: "goal_1", metricKey: "web.sessions", targetValue: 2500 }],
    });
    expect(result.proposals[0]?.currentGoal).toEqual({
      goalId: "goal_1",
      target: 2500,
    });
  });

  it("sonraki ay hedefi, kendisinden önceki aylardan hesaplanır", () => {
    const months = [
      month("2026-06", 30, { sessions: 600 }),
      month("2026-07", 31, { sessions: 3100 }),
      month("2026-08", 31, { sessions: 3100 }),
      month("2026-09", 30, { sessions: 3000 }),
    ];
    const october = proposeTargets({ month: "2026-10", months, goals: NO_GOALS });
    // Son 3 ay: temmuz-eylül, günlük 100 x 31 gün.
    expect(october.proposals[0]?.baseline).toBe(3100);
    expect(october.proposals[0]?.baselineMonths).toBe(3);
    // Ağustos hedefi yalnız haziran ve temmuzu görür.
    const august = proposeTargets({ month: "2026-08", months, goals: NO_GOALS });
    expect(august.proposals[0]?.baselineMonths).toBe(2);
    expect(august.proposals[0]?.baseline).toBeCloseTo(((20 + 100) / 2) * 31, 0);
  });

  it("eksik günlü ay tabana girmez", () => {
    const partial: PlanMonthTotals = { ...month("2026-09", 30, { sessions: 3000 }), days: 20 };
    const result = proposeTargets({
      month: "2026-10",
      months: [month("2026-08", 31, { sessions: 3100 }), partial],
      goals: NO_GOALS,
    });
    expect(result.note).toBe(WEBSITE_REPORT_COPY.planNeedMonths);
  });
});

describe("buildPlanCard", () => {
  const landing = makeSlice(
    "2026-09-30",
    ["landingPage"],
    ["sessions", "keyEvents"],
    [
      ["/pricing", 200, 40],
      ["/blog", 400, 4],
    ],
  );
  const input: PlanReportInput = {
    link: {
      projectId: "proj_1",
      linkId: "link_1",
      propertyName: "Example Shop",
      timeZone: "Europe/Skopje",
      currency: "EUR",
      isMock: false,
      dataThrough: "2026-10-01",
    },
    builtAt: "2026-10-02T08:10:00.000Z",
    websitePage: true,
    month: "2026-10",
    months: [
      month("2026-08", 31, { sessions: 3100, keyEvents: 310 }),
      month("2026-09", 30, { sessions: 3000, keyEvents: 300 }),
    ],
    goals: [],
    findings: [],
    window28: makeWindow(
      { from: "2026-09-04", to: "2026-10-01" },
      { landing: [landing] },
    ),
    forecasts: [],
    historyDays: 120,
  };

  it("kart alanları ve gövde sözleşmeye uyar", () => {
    const card = buildPlanCard(input);
    expect(card.kind).toBe("website-report");
    expect(card.v).toBe(1);
    expect(card.variant).toBe("plan");
    expect(card.title).toBe("Next month plan · October 2026");
    expect(card.periodLabel).toBe("October 2026");
    expect(card.preliminary).toBe(false);
    expect(card.narrative).toBeNull();
    expect(card.dataThrough).toBe("2026-10-01");
    expect(card.body.variant).toBe("plan");
    if (card.body.variant !== "plan") return;
    expect(card.body.month).toBe("2026-10");
    expect(card.body.proposals.map((row) => row.metricKey)).toEqual([
      "web.sessions",
      "web.key_events",
    ]);
    expect(card.body.bestPages[0]?.page).toBe("/pricing");
  });

  it("readWebsiteReportCard ile gidiş-dönüş yapar", () => {
    const card = buildPlanCard(input);
    const read = readWebsiteReportCard(JSON.parse(JSON.stringify(card)));
    expect(read).not.toBeNull();
    expect(read?.variant).toBe("plan");
    expect(read?.body).toEqual(card.body);
  });

  it("veri yetmeyince oturum önerisi yerine not taşır", () => {
    const card = buildPlanCard({
      ...input,
      months: [month("2026-09", 30, { sessions: 3000 })],
    });
    if (card.body.variant !== "plan") throw new Error("plan bekleniyordu");
    expect(card.body.proposals).toEqual([]);
    expect(card.body.proposalNote).toBe(WEBSITE_REPORT_COPY.planNeedMonths);
  });
});

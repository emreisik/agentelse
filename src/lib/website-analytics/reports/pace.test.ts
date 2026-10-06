import { describe, expect, it } from "vitest";

import type { GaAnalysisDay } from "@/lib/website-analytics/analysis/types";
import { addDays } from "@/lib/website-analytics/days";

import {
  expectedShareToDate,
  finalGoalProgress,
  goalPace,
  paceLabel,
  paceTone,
  progressViewOf,
} from "./pace";

function series(
  from: string,
  to: string,
  value: (day: string) => number,
): GaAnalysisDay[] {
  const rows: GaAnalysisDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const sessions = value(day);
    rows.push({
      day,
      sessions,
      engagedSessions: sessions,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      isFinal: true,
    });
  }
  return rows;
}

const base = {
  monthToDate: 100,
  expectedToDate: null,
  dayOfMonth: 15,
};

describe("goalPace", () => {
  it("0.9 sınırında on_track, 0.8999 at_risk", () => {
    expect(goalPace({ ...base, target: 1000, forecast: 900 })).toEqual({
      pace: "on_track",
      ratio: 0.9,
    });
    expect(goalPace({ ...base, target: 10_000, forecast: 8999 })).toEqual({
      pace: "at_risk",
      ratio: 0.8999,
    });
  });

  it("0.7 sınırında at_risk, 0.6999 behind", () => {
    expect(goalPace({ ...base, target: 10_000, forecast: 7000 }).pace).toBe(
      "at_risk",
    );
    expect(goalPace({ ...base, target: 10_000, forecast: 6999 })).toEqual({
      pace: "behind",
      ratio: 0.6999,
    });
  });

  it("ayın 4. gününde early döner", () => {
    expect(
      goalPace({
        target: 10_000,
        monthToDate: 100,
        forecast: 9000,
        expectedToDate: 400,
        dayOfMonth: 4,
      }),
    ).toEqual({ pace: "early", ratio: null });
    expect(
      goalPace({
        target: 10_000,
        monthToDate: 100,
        forecast: 9000,
        expectedToDate: 400,
        dayOfMonth: 5,
      }).pace,
    ).toBe("on_track");
  });

  it("hedefe varıldıysa tahmine ve güne bakılmaz", () => {
    expect(
      goalPace({
        target: 1000,
        monthToDate: 1000,
        forecast: 500,
        expectedToDate: null,
        dayOfMonth: 2,
      }),
    ).toEqual({ pace: "achieved", ratio: 1 });
  });

  it("hedef yoksa ya da 0 ise unknown", () => {
    expect(goalPace({ ...base, target: null, forecast: 900 })).toEqual({
      pace: "unknown",
      ratio: null,
    });
    expect(goalPace({ ...base, target: 0, forecast: 900 }).pace).toBe(
      "unknown",
    );
  });

  it("tahmin yoksa ay başından bugüne / beklenen oranı kullanılır", () => {
    expect(
      goalPace({
        target: 3000,
        monthToDate: 400,
        forecast: null,
        expectedToDate: 1000,
        dayOfMonth: 10,
      }),
    ).toEqual({ pace: "behind", ratio: 0.4 });
    expect(
      goalPace({
        target: 3000,
        monthToDate: 950,
        forecast: null,
        expectedToDate: 1000,
        dayOfMonth: 10,
      }).pace,
    ).toBe("on_track");
    expect(
      goalPace({
        target: 3000,
        monthToDate: 950,
        forecast: null,
        expectedToDate: null,
        dayOfMonth: 10,
      }).pace,
    ).toBe("unknown");
  });
});

describe("paceLabel ve paceTone", () => {
  it("etiketler ve tonlar sözleşmeye uyar", () => {
    expect(paceLabel("achieved")).toBe("Achieved");
    expect(paceLabel("on_track")).toBe("On track");
    expect(paceLabel("at_risk")).toBe("At risk");
    expect(paceLabel("behind")).toBe("Behind");
    expect(paceLabel("early")).toBe("Too early to tell");
    expect(paceLabel("unknown")).toBe("No forecast yet");
    expect(paceTone("achieved")).toBe("good");
    expect(paceTone("on_track")).toBe("good");
    expect(paceTone("at_risk")).toBe("warn");
    expect(paceTone("behind")).toBe("bad");
    expect(paceTone("early")).toBe("neutral");
    expect(paceTone("unknown")).toBe("neutral");
  });
});

describe("expectedShareToDate", () => {
  it("hafta sonu hafif desende doğrusal paydan küçüktür", () => {
    // 2026-09-06 Pazar: ilk 6 günün 2'si hafta sonu (5 ve 6); ay genelinde
    // 8/30. Hafta içi 100, hafta sonu 20.
    const weekend = (day: string) => {
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6 ? 20 : 100;
    };
    const days = series("2026-06-01", "2026-09-06", weekend);
    const share = expectedShareToDate({
      days,
      metric: "sessions",
      through: "2026-09-06",
      exclude: new Set(),
    });
    expect(share).not.toBeNull();
    // (4 x 100 + 2 x 20) / (22 x 100 + 8 x 20)
    expect(share as number).toBe(0.1864);
    expect(share as number).toBeLessThan(6 / 30);
  });

  it("düz seride pay doğrusaldır ve 4 ondalığa yuvarlanır", () => {
    const days = series("2026-06-01", "2026-09-10", () => 100);
    expect(
      expectedShareToDate({
        days,
        metric: "sessions",
        through: "2026-09-10",
        exclude: new Set(),
      }),
    ).toBe(0.3333);
  });

  it("hiç taban yoksa ağırlıklar eşittir; ayın son günü pay 1", () => {
    expect(
      expectedShareToDate({
        days: [],
        metric: "sessions",
        through: "2026-09-15",
        exclude: new Set(),
      }),
    ).toBe(0.5);
    expect(
      expectedShareToDate({
        days: series("2026-06-01", "2026-09-30", () => 100),
        metric: "sessions",
        through: "2026-09-30",
        exclude: new Set(),
      }),
    ).toBe(1);
  });
});

const goal = {
  id: "g1",
  title: "Website sessions per month",
  status: "ACTIVE",
  metricKey: "web.sessions" as const,
  targetValue: 10_000 as number | null,
};

const progress = {
  month: "2026-09",
  through: "2026-09-15",
  dayOfMonth: 15,
  daysInMonth: 30,
  monthToDate: 4000,
  expectedShare: 0.5,
  forecast: 8000,
  forecastLow: 7500,
  forecastHigh: 8500,
  forecastBasis: "ok" as const,
  updatedAt: "2026-09-16T05:00:00.000Z",
};

describe("progressViewOf", () => {
  it("beklenen ve hız, hedefin güncel değeriyle yeniden hesaplanır", () => {
    const before = progressViewOf({ goal, progress });
    expect(before.expectedToDate).toBe(5000);
    expect(before.pace).toBe("at_risk");
    expect(before.paceRatio).toBe(0.8);

    const lowered = progressViewOf({
      goal: { ...goal, targetValue: 8000 },
      progress,
    });
    expect(lowered.expectedToDate).toBe(4000);
    expect(lowered.pace).toBe("on_track");
    expect(lowered.paceRatio).toBe(1);
    expect(lowered.target).toBe(8000);
  });

  it("hedef yoksa beklenen null ve hız unknown", () => {
    const view = progressViewOf({
      goal: { ...goal, targetValue: null },
      progress,
    });
    expect(view.expectedToDate).toBeNull();
    expect(view.pace).toBe("unknown");
    expect(view.goalId).toBe("g1");
    expect(view.forecastLow).toBe(7500);
  });
});

describe("finalGoalProgress", () => {
  it("biten ay complete olur; toplam hedefe göre achieved ya da behind", () => {
    const views = finalGoalProgress({
      goals: [
        { ...goal, id: "a", targetValue: 9000 },
        { ...goal, id: "b", targetValue: 20_000 },
        {
          id: "c",
          title: "Website revenue per month",
          status: "ACTIVE",
          metricKey: "web.revenue",
          targetValue: 100,
        },
      ],
      month: "2026-09",
      totals: { sessions: 10_000.4, keyEvents: 0, revenue: 99.999 },
      updatedAt: "2026-10-02T05:00:00.000Z",
    });
    const [a, b, c] = views;
    expect(a?.forecastBasis).toBe("complete");
    expect(a?.dayOfMonth).toBe(30);
    expect(a?.daysInMonth).toBe(30);
    expect(a?.monthToDate).toBe(10_000);
    expect(a?.forecast).toBe(10_000);
    expect(a?.forecastLow).toBe(10_000);
    expect(a?.forecastHigh).toBe(10_000);
    expect(a?.through).toBe("2026-09-30");
    expect(a?.pace).toBe("achieved");
    expect(b?.pace).toBe("behind");
    expect(b?.expectedToDate).toBe(20_000);
    expect(c?.monthToDate).toBe(100);
    expect(c?.pace).toBe("achieved");
  });
});

import { describe, expect, it } from "vitest";

import { addDays } from "./dates";
import {
  dailyP6Target,
  planInspections,
  sampleOrder,
  type InspectionPlanInput,
} from "./inspection-plan";

// Bu dosyanın kanıtladığı: plan öncelik sırasına uyar ve URL'yi bir kez
// alır; P2/P3/P4/P5 uygunluk pencereleri; nonP6Cap günün P6 payını ayırır;
// yuva sayısı aşılmaz; P6 sırası tohuma göre deterministiktir; günlük P6
// payı haftanın sonunda hedefi tam tutturur.

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const fresh = { lastInspectedAt: null, inspectCount: 0 };

function input(
  overrides: Partial<InspectionPlanInput> = {},
): InspectionPlanInput {
  return {
    now: NOW,
    slots: 10,
    nonP6Cap: 10,
    p1: [],
    p2: [],
    p3: [],
    p4: [],
    p5: [],
    p6: { pool: [], seed: "site:2026-10-05" },
    ...overrides,
  };
}

describe("planInspections", () => {
  it("follows the priority order and dedupes URLs", () => {
    const plan = planInspections(
      input({
        p1: ["https://x.com/a"],
        p2: [{ url: "https://x.com/b", firstSeenAt: ago(1), ...fresh }],
        p3: [
          { url: "https://x.com/a", ...fresh },
          { url: "https://x.com/c", ...fresh },
        ],
        p4: [{ url: "https://x.com/d", ...fresh }],
        p5: [{ url: "https://x.com/e", ...fresh }],
        p6: { pool: ["https://x.com/f", "https://x.com/c"], seed: "s" },
      }),
    );
    expect(plan).toEqual([
      { url: "https://x.com/a", reason: "P1" },
      { url: "https://x.com/b", reason: "P2" },
      { url: "https://x.com/c", reason: "P3" },
      { url: "https://x.com/d", reason: "P4" },
      { url: "https://x.com/e", reason: "P5" },
      { url: "https://x.com/f", reason: "P6" },
    ]);
  });

  it("applies the P2 windows: 14 days, 3 times, 3 days apart", () => {
    const plan = planInspections(
      input({
        p2: [
          { url: "https://x.com/new", firstSeenAt: ago(2), ...fresh },
          { url: "https://x.com/old", firstSeenAt: ago(15), ...fresh },
          {
            url: "https://x.com/three",
            firstSeenAt: ago(10),
            lastInspectedAt: ago(4),
            inspectCount: 3,
          },
          {
            url: "https://x.com/recent",
            firstSeenAt: ago(10),
            lastInspectedAt: ago(2),
            inspectCount: 1,
          },
          {
            url: "https://x.com/due",
            firstSeenAt: ago(10),
            lastInspectedAt: ago(3),
            inspectCount: 2,
          },
        ],
      }),
    );
    expect(plan.map((item) => item.url)).toEqual([
      "https://x.com/new",
      "https://x.com/due",
    ]);
  });

  it("re-inspects P3 after 7 days, P4 after 3 days and P5 after 7 days", () => {
    const row = (url: string, days: number) => ({
      url,
      lastInspectedAt: ago(days),
      inspectCount: 1,
    });
    const plan = planInspections(
      input({
        p3: [row("https://x.com/p3-6", 6), row("https://x.com/p3-7", 7)],
        p4: [row("https://x.com/p4-2", 2), row("https://x.com/p4-3", 3)],
        p5: [row("https://x.com/p5-6", 6), row("https://x.com/p5-8", 8)],
      }),
    );
    expect(plan).toEqual([
      { url: "https://x.com/p3-7", reason: "P3" },
      { url: "https://x.com/p4-3", reason: "P4" },
      { url: "https://x.com/p5-8", reason: "P5" },
    ]);
  });

  it("keeps the P6 reserve with nonP6Cap, but never blocks P1", () => {
    const plan = planInspections(
      input({
        nonP6Cap: 2,
        p1: ["https://x.com/q1", "https://x.com/q2", "https://x.com/q3"],
        p3: [
          { url: "https://x.com/t1", ...fresh },
          { url: "https://x.com/t2", ...fresh },
        ],
        p6: { pool: ["https://x.com/s1", "https://x.com/s2"], seed: "s" },
      }),
    );
    expect(plan.filter((item) => item.reason === "P1")).toHaveLength(3);
    expect(plan.filter((item) => item.reason === "P3")).toHaveLength(0);
    expect(plan.filter((item) => item.reason === "P6")).toHaveLength(2);

    const capped = planInspections(
      input({
        nonP6Cap: 1,
        p3: [
          { url: "https://x.com/t1", ...fresh },
          { url: "https://x.com/t2", ...fresh },
        ],
        p6: { pool: ["https://x.com/s1"], seed: "s" },
      }),
    );
    expect(capped.map((item) => item.reason)).toEqual(["P3", "P6"]);
  });

  it("respects the slot count", () => {
    const pool = Array.from({ length: 30 }, (_, i) => `https://x.com/s${i}`);
    const plan = planInspections(
      input({
        slots: 4,
        p1: ["https://x.com/q1"],
        p6: { pool, seed: "s" },
      }),
    );
    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({ url: "https://x.com/q1", reason: "P1" });
    expect(
      planInspections(input({ slots: 0, p1: ["https://x.com/q"] })),
    ).toEqual([]);
  });
});

describe("sampleOrder", () => {
  it("is deterministic per seed and keeps relative order in a subset", () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://x.com/p${i}`);
    const first = sampleOrder(urls, "site:2026-10-05");
    expect(sampleOrder([...urls].reverse(), "site:2026-10-05")).toEqual(first);
    expect(new Set(first).size).toBe(50);
    expect(sampleOrder(urls, "site:2026-10-12")).not.toEqual(first);
    const subset = first.filter((_, index) => index % 3 === 0);
    expect(sampleOrder(subset, "site:2026-10-05")).toEqual(subset);
  });
});

describe("dailyP6Target", () => {
  it("spreads the weekly target over the remaining days", () => {
    const weekStart = "2026-10-05";
    let sampledThisWeek = 0;
    const perDay: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const today = addDays(weekStart, index);
      const quota = dailyP6Target({
        target: 100,
        sampledThisWeek,
        sampledToday: 0,
        today,
        weekStart,
      });
      perDay.push(quota);
      sampledThisWeek += quota;
    }
    expect(perDay.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(Math.max(...perDay)).toBeLessThanOrEqual(15);
  });

  it("counts what was already sampled today", () => {
    const base = { target: 70, today: "2026-10-05", weekStart: "2026-10-05" };
    expect(
      dailyP6Target({ ...base, sampledThisWeek: 0, sampledToday: 0 }),
    ).toBe(10);
    expect(
      dailyP6Target({ ...base, sampledThisWeek: 4, sampledToday: 4 }),
    ).toBe(6);
    expect(
      dailyP6Target({ ...base, sampledThisWeek: 12, sampledToday: 12 }),
    ).toBe(0);
    // Hafta hedefi dolduysa hiç pay kalmaz.
    expect(
      dailyP6Target({
        target: 20,
        sampledThisWeek: 20,
        sampledToday: 0,
        today: "2026-10-11",
        weekStart: "2026-10-05",
      }),
    ).toBe(0);
  });
});

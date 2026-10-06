import { describe, expect, it, vi } from "vitest";

import type { GaHealthDay } from "@/lib/website-analytics/health/types";
import type { GaDayTotals } from "@/server/website-analytics/store";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { fillMissingDays, healthDaysOf } = await import("./inputs");

// Bu dosyanın kanıtladığı: yapay sıfır günleri yalnız [ilk saklanan gün,
// completeThrough] aralığına eklenir; completeThrough yoksa hiç eklenmez;
// eklenen günler synthetic işaretlidir; ambardaki (kısmi) dün yapay sayılmaz
// ve completeThrough dünle sınırlanır.

function stored(day: string, sessions = 100): GaHealthDay {
  return {
    day,
    sessions,
    engagedSessions: 50,
    engagementSec: 900,
    screenPageViews: 240,
    keyEvents: 4,
    revenueMicros: 0,
    transactions: 0,
    isFinal: true,
    synthetic: false,
  };
}

function totals(day: string, sessions = 100): GaDayTotals {
  return {
    day,
    isFinal: false,
    activeUsers: 80,
    newUsers: 40,
    sessions,
    engagedSessions: 50,
    engagementSec: 900,
    sessionDurationSec: 1200,
    screenPageViews: 240,
    keyEvents: 4,
    revenueMicros: BigInt(1_500_000),
    transactions: 1,
  };
}

describe("fillMissingDays", () => {
  it("fills only the gaps inside [first stored day, completeThrough]", () => {
    const days = fillMissingDays(
      [stored("2026-10-01"), stored("2026-10-03")],
      "2026-10-05",
    );
    expect(days.map((day) => day.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(days.filter((day) => day.synthetic).map((day) => day.day)).toEqual([
      "2026-10-02",
      "2026-10-04",
      "2026-10-05",
    ]);
    // İlk saklanan günden önceye yapay gün eklenmez.
    expect(days[0]).toMatchObject({ day: "2026-10-01", synthetic: false });
  });

  it("marks synthetic days as zero, non-final rows", () => {
    const [, gap] = fillMissingDays(
      [stored("2026-10-01"), stored("2026-10-03")],
      "2026-10-03",
    );
    expect(gap).toEqual({
      day: "2026-10-02",
      sessions: 0,
      engagedSessions: 0,
      engagementSec: 0,
      screenPageViews: 0,
      keyEvents: 0,
      revenueMicros: 0,
      transactions: 0,
      isFinal: false,
      synthetic: true,
    });
  });

  it("does not fill anything without completeThrough", () => {
    const input = [stored("2026-10-01"), stored("2026-10-04")];
    expect(fillMissingDays(input, null)).toEqual(input);
  });

  it("does not fill when nothing is stored", () => {
    expect(fillMissingDays([], "2026-10-05")).toEqual([]);
  });

  it("keeps stored days after completeThrough and returns them ascending", () => {
    const days = fillMissingDays(
      [stored("2026-10-06", 12), stored("2026-10-03")],
      "2026-10-04",
    );
    expect(days.map((day) => [day.day, day.synthetic])).toEqual([
      ["2026-10-03", false],
      ["2026-10-04", true],
      ["2026-10-06", false],
    ]);
  });
});

describe("healthDaysOf", () => {
  it("keeps a partial stored yesterday non-synthetic", () => {
    // lastDailyDate = bugün → completeThrough = dün; dün ambarda (kısmi).
    const days = healthDaysOf(
      [totals("2026-10-03"), totals("2026-10-05", 7)],
      "2026-10-05",
      "2026-10-05",
    );
    expect(days.map((day) => [day.day, day.synthetic, day.sessions])).toEqual([
      ["2026-10-03", false, 100],
      ["2026-10-04", true, 0],
      ["2026-10-05", false, 7],
    ]);
    expect(days[0]?.revenueMicros).toBe(1_500_000);
  });

  it("turns a missing yesterday into a zero day once the sync completed it", () => {
    const days = healthDaysOf(
      [totals("2026-10-03"), totals("2026-10-04")],
      "2026-10-05",
      "2026-10-05",
    );
    expect(days.at(-1)).toMatchObject({
      day: "2026-10-05",
      sessions: 0,
      synthetic: true,
    });
  });

  it("caps completeThrough at yesterday", () => {
    const days = healthDaysOf(
      [totals("2026-10-03")],
      "2026-10-09",
      "2026-10-05",
    );
    expect(days.at(-1)?.day).toBe("2026-10-05");
  });

  it("judges nothing past completeThrough when the daily sync is behind", () => {
    const days = healthDaysOf(
      [totals("2026-10-01")],
      "2026-10-02",
      "2026-10-05",
    );
    expect(days.map((day) => day.day)).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("adds no zero days before the first daily sync", () => {
    expect(
      healthDaysOf([totals("2026-10-01")], null, "2026-10-05"),
    ).toHaveLength(1);
  });
});

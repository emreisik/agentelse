import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import {
  lastDays,
  median,
  sameWeekdayMedian,
  share,
  sumColumn,
} from "./baseline";
import type { GaHealthDay } from "./types";

// Taban çizgisi yardımcıları: medyan kopyayı sıralar, aynı hafta günü
// medyanı hariç günleri atlar ve 4 değerden azda null döner, ardışık gün
// listesi boşlukta null.

function day(key: string, sessions: number): GaHealthDay {
  return {
    day: key,
    sessions,
    engagedSessions: 0,
    engagementSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: 0,
    transactions: 0,
    isFinal: true,
    synthetic: false,
  };
}

describe("baseline helpers", () => {
  it("median sorts a copy", () => {
    const values = [5, 1, 3];
    expect(median(values)).toBe(3);
    expect(values).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("share and sumColumn", () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(1, 0)).toBeNull();
    expect(
      sumColumn(
        [
          { key: ["a"], values: [2, 5] },
          { key: ["b"], values: [3] },
        ],
        1,
      ),
    ).toBe(5);
  });

  it("sameWeekdayMedian skips missing and excluded days and needs four values", () => {
    const target = "2026-10-05";
    const days = [1, 2, 3, 4, 5, 6, 7, 8].map((k) =>
      day(addDays(target, -7 * k), k * 10),
    );
    expect(sameWeekdayMedian(days, target, new Set())).toEqual({
      median: 45,
      count: 8,
    });
    // Ara günler sayılmaz.
    const noisy = [...days, day(addDays(target, -1), 1000)];
    expect(sameWeekdayMedian(noisy, target, new Set()).median).toBe(45);
    const excluded = new Set([addDays(target, -7), addDays(target, -14)]);
    expect(sameWeekdayMedian(days, target, excluded)).toEqual({
      median: 55,
      count: 6,
    });
    expect(sameWeekdayMedian(days.slice(0, 3), target, new Set())).toEqual({
      median: null,
      count: 3,
    });
    expect(sameWeekdayMedian(days, target, new Set(), 4)).toEqual({
      median: 25,
      count: 4,
    });
  });

  it("lastDays returns consecutive days or null on a gap", () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"].map(
      (key) => day(key, 1),
    );
    expect(lastDays(days, "2026-10-03", 3)?.map((d) => d.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(lastDays(days, "2026-10-05", 2)).toBeNull();
  });
});

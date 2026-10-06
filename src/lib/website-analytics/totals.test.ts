import { describe, expect, it } from "vitest";

import {
  averageSessionSeconds,
  engagementRate,
  engagementSecondsPerSession,
  revenue,
  sumTotals,
  type GaTotalsRow,
} from "./totals";

const day = (
  sessions: number,
  overrides: Partial<GaTotalsRow> = {},
): GaTotalsRow => ({
  activeUsers: 10,
  newUsers: 4,
  sessions,
  engagedSessions: Math.round(sessions / 2),
  engagementSec: sessions * 60,
  sessionDurationSec: sessions * 90,
  screenPageViews: sessions * 2,
  keyEvents: 1.5,
  revenueMicros: BigInt(2_500_000),
  transactions: 1,
  ...overrides,
});

describe("period totals", () => {
  it("adds what adds up and computes rates from their parts", () => {
    const totals = sumTotals([day(100), day(300)]);
    expect(totals.sessions).toBe(400);
    expect(totals.newUsers).toBe(8);
    // Günlük kullanıcıların toplamı tekil kullanıcı değildir; adı bunu söyler.
    expect(totals.dailyActiveUsersSum).toBe(20);
    expect(engagementRate(totals)).toBe(50);
    expect(averageSessionSeconds(totals)).toBe(90);
    expect(engagementSecondsPerSession(totals)).toBe(60);
    expect(totals.keyEvents).toBe(3);
    expect(revenue(totals)).toBe(5);
  });

  it("has no rates without sessions", () => {
    const totals = sumTotals([]);
    expect(engagementRate(totals)).toBeNull();
    expect(averageSessionSeconds(totals)).toBeNull();
    expect(revenue(totals)).toBe(0);
  });
});

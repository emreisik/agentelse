import { describe, expect, it } from "vitest";

import {
  countServerError,
  gaQuotaDecision,
  nextHour,
  nextQuotaDay,
  serverErrorBudgetSpent,
  serverErrorsThisHour,
  type StoredGaQuota,
} from "./governor";

// Bu dosyanın kanıtladığı (kabul ölçütü "kota yöneticisi saatlik payı ve
// sunucu hatası sayacını uyguluyor"): arka plan işi saatlik payın %20'si,
// günlüğün %10'u altında durur; geri doldurma saatlik payın yarısını
// kullanmaz; kullanıcının beklediği okuma %5'e kadar sürer; eski kota
// okuması karar vermez; saatte 3 sunucu hatasından sonra arka plan durur.

const now = new Date("2026-10-06T15:20:00.000Z");

function quota(
  hourlyRemaining: number,
  dailyRemaining = 190_000,
  at = "2026-10-06T15:00:00.000Z",
): StoredGaQuota {
  return {
    at,
    quota: {
      tokensPerHour: {
        consumed: 40_000 - hourlyRemaining,
        remaining: hourlyRemaining,
      },
      tokensPerDay: {
        consumed: 200_000 - dailyRemaining,
        remaining: dailyRemaining,
      },
    },
  };
}

const decide = (
  lane: "P1" | "P2" | "P2_BACKFILL",
  stored: StoredGaQuota | null,
  rateLimitedUntil: Date | null = null,
) => gaQuotaDecision({ lane, now, stored, rateLimitedUntil });

describe("gaQuotaDecision", () => {
  it("lets work run without a quota reading", () => {
    expect(decide("P2", null)).toEqual({ ok: true });
  });

  it("holds background work under 20% of the hour, backfill under 50%", () => {
    expect(decide("P2", quota(9_000)).ok).toBe(true);
    expect(decide("P2", quota(7_000))).toEqual({
      ok: false,
      reason: "HOURLY",
      retryAt: new Date("2026-10-06T16:00:00.000Z"),
    });
    expect(decide("P2_BACKFILL", quota(19_000)).ok).toBe(false);
    expect(decide("P2_BACKFILL", quota(21_000)).ok).toBe(true);
    // Kullanıcının beklediği okuma %5'e kadar sürer.
    expect(decide("P1", quota(3_000)).ok).toBe(true);
    expect(decide("P1", quota(1_000)).ok).toBe(false);
  });

  it("stops background work for the day under 10% of the daily quota", () => {
    const decision = decide("P2", quota(30_000, 15_000));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("DAILY");
      expect(decision.retryAt).toEqual(nextQuotaDay(now));
    }
  });

  it("ignores an hourly reading older than an hour and yesterday's daily one", () => {
    expect(
      decide("P2", quota(1_000, 190_000, "2026-10-06T14:00:00.000Z")).ok,
    ).toBe(true);
    expect(
      decide("P2", quota(30_000, 1_000, "2026-10-05T15:00:00.000Z")).ok,
    ).toBe(true);
  });

  it("respects a block Google asked for", () => {
    const until = new Date("2026-10-06T15:45:00.000Z");
    expect(decide("P1", null, until)).toEqual({
      ok: false,
      reason: "BLOCKED",
      retryAt: until,
    });
  });
});

describe("server errors and quota days", () => {
  it("counts per hour and stops background work at three", () => {
    let record = countServerError(null, now);
    record = countServerError(record, now);
    expect(serverErrorsThisHour(record, now)).toBe(2);
    expect(serverErrorBudgetSpent(record, "P2", now)).toBe(false);
    record = countServerError(record, now);
    expect(serverErrorBudgetSpent(record, "P2", now)).toBe(true);
    expect(serverErrorBudgetSpent(record, "P1", now)).toBe(false);
    // Yeni saatte sayaç sıfırdan başlar.
    expect(serverErrorsThisHour(record, nextHour(now))).toBe(0);
  });

  it("finds the next Pacific midnight", () => {
    // 15:20 UTC = 08:20 PDT; sonraki gece yarısı 07:00 UTC.
    expect(nextQuotaDay(now)).toEqual(new Date("2026-10-07T07:00:00.000Z"));
  });
});

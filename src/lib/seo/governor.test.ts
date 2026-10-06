import { describe, expect, it } from "vitest";

import {
  applyQuotaError,
  createMinuteLimiter,
  GSC_LOAD_SHORT_WAIT_MS,
  GSC_RATE_WAIT_MS,
  gscQuotaDecision,
  heavyBlocked,
  nextPacificMidnight,
  parseLoadErrors,
  quotaStateOf,
  type GscQuotaState,
} from "./governor";

// Bu dosyanın kanıtladığı: karar sırası RATE > LOAD > HEAVY; hafif istek
// ağır blokta geçer; LOAD kademelenmesi (ilk hata 15 dk, ikincisi ağırları
// PT gece yarısına kadar durdurur, sayaç yeni PT gününde sıfırlanır); DAILY
// gece yarısına kadar bekletir; dakika sınırı 31. isteği reddeder.

const EMPTY: GscQuotaState = {
  rateLimitedUntil: null,
  loadLimitedUntil: null,
  heavyLimitedUntil: null,
  loadErrors: null,
};

// 2026-10-06 10:00 PDT
const NOW = new Date("2026-10-06T17:00:00Z");
// 2026-10-07 00:00 PDT
const MIDNIGHT = new Date("2026-10-07T07:00:00Z");

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe("gscQuotaDecision", () => {
  it("passes with no limits", () => {
    expect(gscQuotaDecision({ heavy: true, now: NOW, state: EMPTY })).toEqual({
      ok: true,
    });
  });

  it("orders RATE > LOAD > HEAVY", () => {
    const state: GscQuotaState = {
      rateLimitedUntil: after(60_000),
      loadLimitedUntil: after(120_000),
      heavyLimitedUntil: after(180_000),
      loadErrors: null,
    };
    expect(gscQuotaDecision({ heavy: true, now: NOW, state })).toEqual({
      ok: false,
      reason: "RATE",
      retryAt: after(60_000),
    });
    expect(
      gscQuotaDecision({
        heavy: true,
        now: NOW,
        state: { ...state, rateLimitedUntil: null },
      }),
    ).toEqual({ ok: false, reason: "LOAD", retryAt: after(120_000) });
    expect(
      gscQuotaDecision({
        heavy: true,
        now: NOW,
        state: { ...state, rateLimitedUntil: null, loadLimitedUntil: null },
      }),
    ).toEqual({ ok: false, reason: "HEAVY", retryAt: after(180_000) });
  });

  it("lets a light request through while heavy is blocked", () => {
    const state = { ...EMPTY, heavyLimitedUntil: MIDNIGHT };
    expect(gscQuotaDecision({ heavy: false, now: NOW, state })).toEqual({
      ok: true,
    });
    expect(gscQuotaDecision({ heavy: true, now: NOW, state }).ok).toBe(false);
    expect(heavyBlocked(state, NOW)).toBe(true);
    expect(heavyBlocked(state, MIDNIGHT)).toBe(false);
  });

  it("ignores limits that have passed", () => {
    const state = {
      ...EMPTY,
      rateLimitedUntil: NOW,
      loadLimitedUntil: after(-1),
    };
    expect(gscQuotaDecision({ heavy: true, now: NOW, state })).toEqual({
      ok: true,
    });
  });
});

describe("applyQuotaError", () => {
  it("RATE waits at least 60 s or Retry-After", () => {
    expect(
      applyQuotaError({ kind: "RATE", state: EMPTY, now: NOW })
        .rateLimitedUntil,
    ).toEqual(after(GSC_RATE_WAIT_MS));
    expect(
      applyQuotaError({
        kind: "RATE",
        state: EMPTY,
        now: NOW,
        retryAfterMs: 90_000,
      }).rateLimitedUntil,
    ).toEqual(after(90_000));
    expect(
      applyQuotaError({
        kind: "RATE",
        state: EMPTY,
        now: NOW,
        retryAfterMs: 5_000,
      }).rateLimitedUntil,
    ).toEqual(after(GSC_RATE_WAIT_MS));
  });

  it("DAILY waits until Pacific midnight", () => {
    expect(nextPacificMidnight(NOW)).toEqual(MIDNIGHT);
    const state = applyQuotaError({ kind: "DAILY", state: EMPTY, now: NOW });
    expect(state.rateLimitedUntil).toEqual(MIDNIGHT);
    // Sonraki RATE hatası gece yarısı bekletmesini kısaltmaz.
    expect(
      applyQuotaError({ kind: "RATE", state, now: NOW }).rateLimitedUntil,
    ).toEqual(MIDNIGHT);
  });

  it("escalates LOAD errors within one PT day", () => {
    const first = applyQuotaError({ kind: "LOAD", state: EMPTY, now: NOW });
    expect(first.loadErrors).toEqual({ day: "2026-10-06", count: 1 });
    expect(first.loadLimitedUntil).toEqual(after(GSC_LOAD_SHORT_WAIT_MS));
    expect(first.heavyLimitedUntil).toBeNull();

    const later = new Date(NOW.getTime() + 20 * 60_000);
    const second = applyQuotaError({ kind: "LOAD", state: first, now: later });
    expect(second.loadErrors).toEqual({ day: "2026-10-06", count: 2 });
    expect(second.loadLimitedUntil).toEqual(
      new Date(later.getTime() + GSC_LOAD_SHORT_WAIT_MS),
    );
    expect(second.heavyLimitedUntil).toEqual(MIDNIGHT);
  });

  it("resets the LOAD count on a new PT day", () => {
    const state = {
      ...EMPTY,
      loadErrors: { day: "2026-10-05", count: 3 },
    };
    const next = applyQuotaError({ kind: "LOAD", state, now: NOW });
    expect(next.loadErrors).toEqual({ day: "2026-10-06", count: 1 });
    expect(next.heavyLimitedUntil).toBeNull();
  });
});

describe("quotaStateOf", () => {
  it("reads the link columns and parses loadErrors", () => {
    expect(
      quotaStateOf({
        rateLimitedUntil: NOW,
        loadLimitedUntil: null,
        heavyLimitedUntil: MIDNIGHT,
        loadErrors: { day: "2026-10-06", count: 2 },
      }),
    ).toEqual({
      rateLimitedUntil: NOW,
      loadLimitedUntil: null,
      heavyLimitedUntil: MIDNIGHT,
      loadErrors: { day: "2026-10-06", count: 2 },
    });
    expect(
      quotaStateOf({
        rateLimitedUntil: null,
        loadLimitedUntil: null,
        heavyLimitedUntil: null,
        loadErrors: "broken",
      }).loadErrors,
    ).toBeNull();
  });

  it("parseLoadErrors rejects malformed values", () => {
    expect(parseLoadErrors(null)).toBeNull();
    expect(parseLoadErrors([])).toBeNull();
    expect(parseLoadErrors({ day: "2026-10-06" })).toBeNull();
    expect(parseLoadErrors({ day: "yesterday", count: 1 })).toBeNull();
    expect(parseLoadErrors({ day: "2026-10-06", count: 1.5 })).toBeNull();
    expect(parseLoadErrors({ day: "2026-10-06", count: 1 })).toEqual({
      day: "2026-10-06",
      count: 1,
    });
  });
});

describe("createMinuteLimiter", () => {
  it("allows 30 a minute and refuses the 31st until the oldest expires", () => {
    const limiter = createMinuteLimiter();
    const start = 1_000_000;
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.take("sc-domain:example.com", start + i * 100)).toEqual({
        ok: true,
      });
    }
    expect(limiter.take("sc-domain:example.com", start + 5_000)).toEqual({
      ok: false,
      retryAt: start + 60_000,
    });
    // Başka site ayrı kovadır.
    expect(limiter.take("https://other.example/", start + 5_000)).toEqual({
      ok: true,
    });
    // En eski istek pencereden çıkınca yer açılır.
    expect(limiter.take("sc-domain:example.com", start + 60_000)).toEqual({
      ok: true,
    });
    expect(limiter.take("sc-domain:example.com", start + 60_001)).toEqual({
      ok: false,
      retryAt: start + 100 + 60_000,
    });
  });
});

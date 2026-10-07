import { describe, expect, it } from "vitest";
import {
  GA_FIX_APPROVAL_TTL_MS,
  GA_FIX_APPROVED_STALE_MS,
  GA_FIX_INLINE_BUDGET_MS,
  GA_FIX_LEASE_MS,
  GA_FIX_MAX_ATTEMPTS,
  OPEN_FIX_STATUSES,
  canTransitionFix,
  fixBackoffMs,
  mockMatchesLink,
  openKeyFor,
} from "./lifecycle";
import { GA_FIX_STATUSES, type GaFixStatus } from "./types";

const LEGAL: [GaFixStatus, GaFixStatus][] = [
  ["PROPOSED", "APPROVED"],
  ["PROPOSED", "REJECTED"],
  ["PROPOSED", "EXPIRED"],
  ["APPROVED", "APPLYING"],
  ["APPROVED", "FAILED"],
  ["APPROVED", "EXPIRED"],
  ["APPLYING", "APPLIED"],
  ["APPLYING", "VERIFIED"],
  ["APPLYING", "FAILED"],
  ["APPLYING", "APPROVED"],
  ["APPLIED", "VERIFIED"],
  ["APPLIED", "FAILED"],
  ["VERIFIED", "UNDOING"],
  ["UNDOING", "UNDONE"],
  ["UNDOING", "VERIFIED"],
];

describe("canTransitionFix", () => {
  it("her çift tabloya göre", () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
    for (const from of GA_FIX_STATUSES) {
      for (const to of GA_FIX_STATUSES) {
        expect(canTransitionFix(from, to), `${from} > ${to}`).toBe(
          legal.has(`${from}>${to}`),
        );
      }
    }
  });

  it("terminal durumlardan çıkış yok", () => {
    for (const from of ["FAILED", "UNDONE", "REJECTED", "EXPIRED"] as const) {
      for (const to of GA_FIX_STATUSES) {
        expect(canTransitionFix(from, to)).toBe(false);
      }
    }
  });
});

describe("openKeyFor", () => {
  it("yalnız açık durumlarda dedupeKey döner", () => {
    for (const status of GA_FIX_STATUSES) {
      const open = OPEN_FIX_STATUSES.includes(status);
      expect(openKeyFor(status, "k")).toBe(open ? "k" : null);
    }
    expect([...OPEN_FIX_STATUSES]).toEqual([
      "PROPOSED",
      "APPROVED",
      "APPLYING",
      "APPLIED",
    ]);
  });
});

describe("fixBackoffMs", () => {
  const min = 60 * 1000;
  it("2, 10, 30 dakika", () => {
    expect(fixBackoffMs(1, "TRANSIENT")).toBe(2 * min);
    expect(fixBackoffMs(2, "SERVER_ERROR")).toBe(10 * min);
    expect(fixBackoffMs(3, "RATE_LIMIT")).toBe(30 * min);
    expect(fixBackoffMs(9, "TRANSIENT")).toBe(30 * min);
    expect(fixBackoffMs(0, "TRANSIENT")).toBe(2 * min);
  });

  it("günlük kota 6 saat", () => {
    expect(fixBackoffMs(1, "QUOTA_DAILY")).toBe(6 * 60 * min);
    expect(fixBackoffMs(3, "QUOTA_DAILY")).toBe(6 * 60 * min);
  });
});

describe("mockMatchesLink", () => {
  it("doğruluk tablosu", () => {
    expect(mockMatchesLink(true, true)).toBe(true);
    expect(mockMatchesLink(true, false)).toBe(false);
    expect(mockMatchesLink(false, true)).toBe(false);
    expect(mockMatchesLink(false, false)).toBe(true);
  });
});

describe("sabitler", () => {
  it("değerler", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(GA_FIX_APPROVAL_TTL_MS).toBe(7 * day);
    expect(GA_FIX_APPROVED_STALE_MS).toBe(14 * day);
    expect(GA_FIX_INLINE_BUDGET_MS).toBe(20000);
    expect(GA_FIX_MAX_ATTEMPTS).toBe(3);
    expect(GA_FIX_LEASE_MS).toBe(2 * 60 * 1000);
  });
});

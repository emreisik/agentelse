import { describe, expect, it } from "vitest";

import {
  GA_REALTIME_TTL_MS,
  GA_TODAY_TTL_MS,
  cacheFresh,
  parseTodaySoFar,
  todaySoFarRequest,
} from "./live";
import type { GaParsedReport } from "./response";

// Canlı sayıların saf kuralları: bugünün isteği tek gün ve boyutsuz, yanıt
// başlık adıyla okunur (satır yoksa sıfır), önbellek sınırı TTL'de biter.

const report = (rows: GaParsedReport["rows"]): GaParsedReport => ({
  dimensionHeaders: [],
  // Sıra bilerek farklı: değer başlık adıyla okunmalı.
  metricHeaders: [
    "keyEvents",
    "sessions",
    "screenPageViews",
    "activeUsers",
    "newUsers",
  ],
  rows,
  rowCount: rows.length,
  quality: {},
  propertyQuota: null,
});

const input = {
  day: "2026-10-06",
  asOf: "2026-10-06T11:05:00.000Z",
  timeZone: "Europe/Istanbul",
};

describe("todaySoFarRequest", () => {
  it("asks for today only, without dimensions, with the property quota", () => {
    const request = todaySoFarRequest("2026-10-06");
    expect(request.dateRanges).toEqual([
      { startDate: "2026-10-06", endDate: "2026-10-06" },
    ]);
    expect(request.dimensions ?? []).toEqual([]);
    expect(request.metrics.map((metric) => metric.name)).toEqual([
      "sessions",
      "activeUsers",
      "newUsers",
      "keyEvents",
      "screenPageViews",
    ]);
    expect(request.keepEmptyRows).toBe(true);
    expect(request.returnPropertyQuota).toBe(true);
  });
});

describe("parseTodaySoFar", () => {
  it("reads the first row by header name", () => {
    expect(
      parseTodaySoFar(report([{ dimensions: [], metrics: [3, 120, 410, 95, 60] }]), input),
    ).toEqual({
      ...input,
      sessions: 120,
      activeUsers: 95,
      newUsers: 60,
      keyEvents: 3,
      screenPageViews: 410,
    });
  });

  it("gives zeros when Google returns no row (just after midnight)", () => {
    expect(parseTodaySoFar(report([]), input)).toEqual({
      ...input,
      sessions: 0,
      activeUsers: 0,
      newUsers: 0,
      keyEvents: 0,
      screenPageViews: 0,
    });
  });
});

describe("cacheFresh", () => {
  it("is fresh until the TTL has passed, then stale", () => {
    expect(cacheFresh(1_000, 1_000, GA_REALTIME_TTL_MS)).toBe(true);
    expect(cacheFresh(1_000, 1_000 + GA_REALTIME_TTL_MS - 1, GA_REALTIME_TTL_MS)).toBe(true);
    expect(cacheFresh(1_000, 1_000 + GA_REALTIME_TTL_MS, GA_REALTIME_TTL_MS)).toBe(false);
    expect(cacheFresh(0, GA_TODAY_TTL_MS - 1, GA_TODAY_TTL_MS)).toBe(true);
  });

  it("is never fresh without an entry or when the clock went back", () => {
    expect(cacheFresh(undefined, 1_000, GA_TODAY_TTL_MS)).toBe(false);
    expect(cacheFresh(5_000, 1_000, GA_TODAY_TTL_MS)).toBe(false);
  });
});

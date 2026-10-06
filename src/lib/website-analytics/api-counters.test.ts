import { describe, expect, it } from "vitest";

import {
  addCounts,
  gaHourKey,
  parseGaApiCounters,
  sumLastHours,
  trimHours,
} from "./api-counters";

// Bu dosyanın kanıtladığı: sayaçlar UTC saatine yazılır ve birikir; son 25
// saat tutulur; "son 24 saat" toplamı saat sınırlarını doğru keser.

describe("GA API counters", () => {
  it("keys hours in UTC", () => {
    expect(gaHourKey(new Date("2026-10-06T15:59:59.000Z"))).toBe(
      "2026-10-06T15",
    );
    expect(gaHourKey(new Date("2026-10-07T01:30:00+03:00"))).toBe(
      "2026-10-06T22",
    );
  });

  it("adds counts per hour and outcome", () => {
    let data = addCounts(null, "2026-10-06T15", { ok: 5 });
    data = addCounts(data, "2026-10-06T15", { ok: 2, SERVER_ERROR: 1 });
    data = addCounts(data, "2026-10-06T16", { ok: 1 });
    expect(data).toEqual({
      v: 1,
      hours: {
        "2026-10-06T15": { ok: 7, SERVER_ERROR: 1 },
        "2026-10-06T16": { ok: 1 },
      },
    });
    expect(parseGaApiCounters(data)).toEqual(data);
    expect(parseGaApiCounters({ v: 2 })).toBeNull();
    expect(parseGaApiCounters(null)).toBeNull();
  });

  it("keeps the last 25 hours", () => {
    const now = new Date("2026-10-06T15:10:00.000Z");
    let data = addCounts(null, "2026-10-05T14", { ok: 1 });
    data = addCounts(data, "2026-10-05T15", { ok: 1 });
    data = addCounts(data, "2026-10-06T15", { ok: 1 });
    expect(Object.keys(trimHours(data, now).hours)).toEqual([
      "2026-10-05T15",
      "2026-10-06T15",
    ]);
    expect(Object.keys(trimHours(data, now, 1).hours)).toEqual([
      "2026-10-06T15",
    ]);
  });

  it("sums the last hours across hour boundaries", () => {
    const now = new Date("2026-10-06T15:00:00.000Z");
    let data = addCounts(null, "2026-10-05T15", { ok: 100 });
    data = addCounts(data, "2026-10-05T16", { ok: 3, RATE_LIMIT: 1 });
    data = addCounts(data, "2026-10-06T14", { ok: 2 });
    data = addCounts(data, "2026-10-06T15", { ok: 1, AUTH: 2 });
    // Gelecek saat sayılmaz.
    data = addCounts(data, "2026-10-06T16", { ok: 50 });
    expect(sumLastHours(data, now, 24)).toEqual({
      ok: 6,
      RATE_LIMIT: 1,
      AUTH: 2,
    });
    expect(sumLastHours(data, now, 2)).toEqual({ ok: 3, AUTH: 2 });
    expect(sumLastHours(null, now, 24)).toEqual({});
  });
});

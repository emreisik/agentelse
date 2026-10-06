import { describe, expect, it } from "vitest";

import {
  completeThroughOf,
  GA_HEALTH_EVERY_MS,
  GA_SITE_SCAN_EVERY_MS,
  gaHealthDue,
  gaHealthFingerprint,
  recheckThrottledUntil,
  weeklyProbeDue,
} from "./schedule";

// Zamanlama: parmak izi değişince, 6 saatte bir ve "I fixed it" sonrası tam
// tur; haftalık yoklama sınırı; 10 dakikalık yeniden denetim kısıtı.

const now = new Date("2026-10-06T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("GA health schedule", () => {
  it("fingerprint changes with the day, the daily date and the metadata day", () => {
    const base = {
      today: "2026-10-06",
      lastDailyDate: "2026-10-06",
      lastMetadataAt: new Date("2026-10-06T03:00:00Z"),
    };
    const fp = gaHealthFingerprint(base);
    expect(fp).toBe("v1|2026-10-06|2026-10-06|2026-10-06");
    expect(gaHealthFingerprint({ ...base, today: "2026-10-07" })).not.toBe(fp);
    expect(gaHealthFingerprint({ ...base, lastDailyDate: null })).toBe(
      "v1|2026-10-06|-|2026-10-06",
    );
    expect(
      gaHealthFingerprint({
        ...base,
        lastMetadataAt: new Date("2026-10-06T23:00:00Z"),
      }),
    ).toBe(fp);
    expect(gaHealthFingerprint({ ...base, lastMetadataAt: null })).toBe(
      "v1|2026-10-06|2026-10-06|-",
    );
  });

  it("is due without a run, on a new fingerprint and after six hours", () => {
    const fingerprint = "v1|a";
    const run = {
      fingerprint,
      evaluatedAt: ago(GA_HEALTH_EVERY_MS - 1),
      recheckRequestedAt: null,
    };
    expect(gaHealthDue({ fingerprint, run: null, now })).toBe(true);
    expect(
      gaHealthDue({ fingerprint, run: { ...run, evaluatedAt: null }, now }),
    ).toBe(true);
    expect(gaHealthDue({ fingerprint, run, now })).toBe(false);
    expect(gaHealthDue({ fingerprint: "v1|b", run, now })).toBe(true);
    expect(
      gaHealthDue({
        fingerprint,
        run: { ...run, evaluatedAt: ago(GA_HEALTH_EVERY_MS) },
        now,
      }),
    ).toBe(true);
  });

  it("is due when a recheck was requested after the last evaluation", () => {
    const fingerprint = "v1|a";
    const evaluatedAt = ago(60_000);
    expect(
      gaHealthDue({
        fingerprint,
        run: { fingerprint, evaluatedAt, recheckRequestedAt: ago(30_000) },
        now,
      }),
    ).toBe(true);
    expect(
      gaHealthDue({
        fingerprint,
        run: { fingerprint, evaluatedAt, recheckRequestedAt: ago(90_000) },
        now,
      }),
    ).toBe(false);
  });

  it("weekly probes run at the boundary or when forced", () => {
    expect(weeklyProbeDue(null, now, GA_SITE_SCAN_EVERY_MS, false)).toBe(true);
    expect(
      weeklyProbeDue(
        ago(GA_SITE_SCAN_EVERY_MS - 1),
        now,
        GA_SITE_SCAN_EVERY_MS,
        false,
      ),
    ).toBe(false);
    expect(
      weeklyProbeDue(
        ago(GA_SITE_SCAN_EVERY_MS),
        now,
        GA_SITE_SCAN_EVERY_MS,
        false,
      ),
    ).toBe(true);
    expect(weeklyProbeDue(ago(1), now, GA_SITE_SCAN_EVERY_MS, true)).toBe(true);
  });

  it("throttles rechecks for ten minutes", () => {
    expect(recheckThrottledUntil(null, now)).toBeNull();
    expect(recheckThrottledUntil(ago(9 * 60_000), now)).toEqual(
      new Date(now.getTime() + 60_000),
    );
    expect(recheckThrottledUntil(ago(10 * 60_000), now)).toBeNull();
  });

  it("completeThroughOf is the day before lastDailyDate", () => {
    expect(completeThroughOf("2026-10-01")).toBe("2026-09-30");
    expect(completeThroughOf(null)).toBeNull();
  });
});

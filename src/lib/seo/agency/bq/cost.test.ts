import { describe, expect, it } from "vitest";

import {
  currentUsageMonth,
  decideSpend,
  formatBytes,
  recordSpend,
  rolloverUsage,
} from "./cost";

const GIB = 1024 ** 3;
const usage = (bytes: number, month: string | null = "2026-10") => ({
  usageMonth: month,
  bytesBilledMonth: bytes,
  queriesMonth: 3,
});
const base = {
  maxBytesPerQuery: 10 * GIB,
  monthlyBudgetBytes: 300 * GIB,
  hardMax: 100 * GIB,
  hardMonthly: 2048 * GIB,
};

describe("usage month", () => {
  it("is YYYY-MM in UTC", () => {
    expect(currentUsageMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(currentUsageMonth(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });

  it("rolls over at a month change and keeps the same month", () => {
    const same = usage(5);
    expect(rolloverUsage(same, new Date("2026-10-15T00:00:00Z"))).toBe(same);
    expect(rolloverUsage(same, new Date("2026-11-01T00:00:00Z"))).toEqual({
      usageMonth: "2026-11",
      bytesBilledMonth: 0,
      queriesMonth: 0,
    });
    expect(rolloverUsage(usage(5, null), new Date("2026-10-15T00:00:00Z"))).toEqual({
      usageMonth: "2026-10",
      bytesBilledMonth: 0,
      queriesMonth: 0,
    });
  });
});

describe("decideSpend", () => {
  it("refuses an estimate above the per-query cap", () => {
    expect(
      decideSpend({ ...base, estimateBytes: 11 * GIB, usage: usage(0) }),
    ).toEqual({ ok: false, reason: "OVER_QUERY_CAP" });
  });

  it("refuses when the monthly budget would be exceeded", () => {
    expect(
      decideSpend({ ...base, estimateBytes: 2 * GIB, usage: usage(299 * GIB) }),
    ).toEqual({ ok: false, reason: "OVER_MONTHLY_BUDGET" });
  });

  it("clamps the effective caps to the hard maxima", () => {
    expect(
      decideSpend({
        ...base,
        maxBytesPerQuery: 500 * GIB,
        estimateBytes: 150 * GIB,
        usage: usage(0),
      }),
    ).toEqual({ ok: false, reason: "OVER_QUERY_CAP" });
    expect(
      decideSpend({
        ...base,
        monthlyBudgetBytes: 5000 * GIB,
        hardMonthly: 100 * GIB,
        estimateBytes: GIB,
        usage: usage(100 * GIB),
      }),
    ).toEqual({ ok: false, reason: "OVER_MONTHLY_BUDGET" });
  });

  it("uses min(cap, remaining budget) rounded up to 10 MiB", () => {
    const ok = decideSpend({ ...base, estimateBytes: GIB, usage: usage(0) });
    expect(ok).toEqual({ ok: true, maxBytesBilled: 10 * GIB });
    const tight = decideSpend({
      ...base,
      estimateBytes: GIB,
      usage: usage(300 * GIB - 5 * GIB - 1),
    });
    expect(tight.ok).toBe(true);
    if (tight.ok) {
      expect(tight.maxBytesBilled % (10 * 1024 * 1024)).toBe(0);
      expect(tight.maxBytesBilled).toBeGreaterThanOrEqual(5 * GIB);
      expect(tight.maxBytesBilled).toBeLessThan(5 * GIB + 10 * 1024 * 1024 + 2);
    }
  });

  it("allows an estimate exactly at the cap", () => {
    expect(
      decideSpend({ ...base, estimateBytes: 10 * GIB, usage: usage(0) }).ok,
    ).toBe(true);
  });
});

describe("recordSpend", () => {
  it("adds billed bytes and counts the query", () => {
    expect(recordSpend(usage(100), 50)).toEqual({
      usageMonth: "2026-10",
      bytesBilledMonth: 150,
      queriesMonth: 4,
    });
    expect(recordSpend(usage(100), -5).bytesBilledMonth).toBe(100);
  });
});

describe("formatBytes", () => {
  it("formats decimal units", () => {
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatBytes(2_000_000_000)).toBe("2 GB");
    expect(formatBytes(800_000_000)).toBe("800 MB");
    expect(formatBytes(1_200_000_000_000)).toBe("1.2 TB");
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(-4)).toBe("0 B");
  });
});

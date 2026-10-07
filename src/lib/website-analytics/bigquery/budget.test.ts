import { describe, expect, it } from "vitest";

import {
  firstOfNextMonth,
  formatBytes,
  maxBytesCap,
  monthBudgetState,
  monthKeyOf,
  monthlyBudgetBytes,
  sumBytes,
} from "./budget";

describe("maxBytesCap", () => {
  it("defaults to 2e9", () => {
    expect(maxBytesCap({})).toBe(2_000_000_000);
    expect(maxBytesCap({ GA_BIGQUERY_MAX_BYTES: "" })).toBe(2_000_000_000);
    expect(maxBytesCap({ GA_BIGQUERY_MAX_BYTES: "abc" })).toBe(2_000_000_000);
  });

  it("clamps to 1e8..100 GiB", () => {
    expect(maxBytesCap({ GA_BIGQUERY_MAX_BYTES: "5" })).toBe(100_000_000);
    expect(maxBytesCap({ GA_BIGQUERY_MAX_BYTES: "1e12" })).toBe(107_374_182_400);
    expect(maxBytesCap({ GA_BIGQUERY_MAX_BYTES: "3000000000" })).toBe(3_000_000_000);
  });
});

describe("monthlyBudgetBytes", () => {
  it("defaults to 100e9 and reads the env", () => {
    expect(monthlyBudgetBytes({})).toBe(100_000_000_000);
    expect(monthlyBudgetBytes({ GA_BIGQUERY_MONTHLY_BYTES: "50000000000" })).toBe(
      50_000_000_000,
    );
    expect(monthlyBudgetBytes({ GA_BIGQUERY_MONTHLY_BYTES: "nope" })).toBe(
      100_000_000_000,
    );
  });

  it("never goes below 1e8", () => {
    expect(monthlyBudgetBytes({ GA_BIGQUERY_MONTHLY_BYTES: "1" })).toBe(100_000_000);
  });
});

describe("monthBudgetState", () => {
  const now = new Date("2026-10-07T10:00:00Z");

  it("allows a run that fits the remaining budget", () => {
    expect(
      monthBudgetState({
        usageMonth: "2026-10",
        usageBytes: 40,
        monthlyBytes: 100,
        estimateBytes: 60,
        now,
      }),
    ).toEqual({ month: "2026-10", usedBytes: 40, allowed: true });
  });

  it("blocks a run that would exceed the budget", () => {
    expect(
      monthBudgetState({
        usageMonth: "2026-10",
        usageBytes: 40,
        monthlyBytes: 100,
        estimateBytes: 61,
        now,
      }).allowed,
    ).toBe(false);
  });

  it("resets the usage when the month rolls over", () => {
    expect(
      monthBudgetState({
        usageMonth: "2026-09",
        usageBytes: 99,
        monthlyBytes: 100,
        estimateBytes: 50,
        now,
      }),
    ).toEqual({ month: "2026-10", usedBytes: 0, allowed: true });
    expect(
      monthBudgetState({
        usageMonth: null,
        usageBytes: 0,
        monthlyBytes: 100,
        estimateBytes: 50,
        now,
      }).usedBytes,
    ).toBe(0);
  });

  it("uses the SUM of the three dry runs as the estimate", () => {
    const estimate = sumBytes([30, 30, 41]);
    expect(estimate).toBe(101);
    expect(
      monthBudgetState({
        usageMonth: "2026-10",
        usageBytes: 0,
        monthlyBytes: 100,
        estimateBytes: estimate,
        now,
      }).allowed,
    ).toBe(false);
  });
});

describe("helpers", () => {
  it("sumBytes ignores junk", () => {
    expect(sumBytes([1, Number.NaN, -5, 2])).toBe(3);
    expect(sumBytes([])).toBe(0);
  });

  it("computes month keys and the next month start in UTC", () => {
    expect(monthKeyOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(firstOfNextMonth(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(firstOfNextMonth(new Date("2026-10-07T00:00:00Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(2_000_000_000)).toBe("2 GB");
    expect(formatBytes(100_000_000_000)).toBe("100 GB");
  });
});

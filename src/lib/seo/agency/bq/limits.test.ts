import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_BYTES_PER_QUERY,
  DEFAULT_MONTHLY_BYTES,
  MAX_BYTES_CHOICES_GB,
  MONTHLY_CHOICES_GB,
  gbToBytes,
  hardMaxBytes,
  hardMonthlyBytes,
  rowCap,
} from "./limits";

describe("rowCap", () => {
  it("defaults to 100000", () => {
    expect(rowCap({})).toBe(100_000);
    expect(rowCap({ GSC_BQ_ROW_CAP: "" })).toBe(100_000);
    expect(rowCap({ GSC_BQ_ROW_CAP: "abc" })).toBe(100_000);
    expect(rowCap({ GSC_BQ_ROW_CAP: "-5" })).toBe(100_000);
  });

  it("clamps to 1000..500000", () => {
    expect(rowCap({ GSC_BQ_ROW_CAP: "10" })).toBe(1_000);
    expect(rowCap({ GSC_BQ_ROW_CAP: "62000" })).toBe(62_000);
    expect(rowCap({ GSC_BQ_ROW_CAP: "9999999" })).toBe(500_000);
  });
});

describe("hard ceilings", () => {
  it("defaults to 100 GiB per query and 2 TiB per month", () => {
    expect(hardMaxBytes({})).toBe(107_374_182_400);
    expect(hardMonthlyBytes({})).toBe(2_199_023_255_552);
  });

  it("reads the environment and never exceeds the absolute client limit", () => {
    expect(hardMaxBytes({ GSC_BQ_HARD_MAX_BYTES: "5000000000" })).toBe(
      5_000_000_000,
    );
    expect(hardMaxBytes({ GSC_BQ_HARD_MAX_BYTES: "9999999999999" })).toBe(
      214_748_364_800,
    );
    expect(hardMonthlyBytes({ GSC_BQ_HARD_MONTHLY_BYTES: "1000" })).toBe(1000);
  });

  it("ignores junk values", () => {
    expect(hardMaxBytes({ GSC_BQ_HARD_MAX_BYTES: "x" })).toBe(107_374_182_400);
    expect(hardMonthlyBytes({ GSC_BQ_HARD_MONTHLY_BYTES: "0" })).toBe(
      2_199_023_255_552,
    );
  });
});

describe("defaults and choices", () => {
  it("matches the stored column defaults", () => {
    expect(DEFAULT_MAX_BYTES_PER_QUERY).toBe(10_737_418_240);
    expect(DEFAULT_MONTHLY_BYTES).toBe(322_122_547_200);
  });

  it("offers the documented choices", () => {
    expect(MAX_BYTES_CHOICES_GB).toEqual([5, 10, 25, 50, 100]);
    expect(MONTHLY_CHOICES_GB).toEqual([50, 100, 300, 1000, 2000]);
    expect(gbToBytes(10)).toBe(DEFAULT_MAX_BYTES_PER_QUERY);
  });
});

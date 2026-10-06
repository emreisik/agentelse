import { describe, expect, it } from "vitest";

import {
  formatMoney,
  minorUnitOffset,
  parseMajorText,
  toMajorUnits,
  toMinorUnits,
} from "@/lib/ads/money";

describe("money (docs/meta-ads-plan.md F0b)", () => {
  it("uses Meta's offsets: 100 for most currencies, 1 for zero-decimal ones", () => {
    expect(minorUnitOffset("TRY")).toBe(100);
    expect(minorUnitOffset("jpy")).toBe(1);
    expect(minorUnitOffset("HUF")).toBe(1);
    expect(minorUnitOffset(undefined)).toBe(100);
  });

  it("converts both ways without the 100x error", () => {
    expect(toMinorUnits(20, "TRY")).toBe(2000);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMajorUnits(2000, "TRY")).toBe(20);
    expect(toMajorUnits(1500, "JPY")).toBe(1500);
  });

  it("reads Insights' decimal spend text into minor units", () => {
    expect(parseMajorText("12.34", "TRY")).toBe(1234);
    expect(parseMajorText("950", "JPY")).toBe(950);
    expect(parseMajorText(undefined, "TRY")).toBe(0);
    expect(parseMajorText("n/a", "TRY")).toBe(0);
  });

  it("formats with the code, and says when the currency is unknown", () => {
    expect(formatMoney(2000, "TRY")).toBe("20 TRY");
    expect(formatMoney(3820, "TRY")).toBe("38.20 TRY");
    expect(formatMoney(1500, "JPY")).toBe("1,500 JPY");
    expect(formatMoney(2500, null)).toBe("25 (account currency)");
  });
});

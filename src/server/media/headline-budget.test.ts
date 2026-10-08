import { describe, expect, it } from "vitest";

import { headlineBudget } from "./headline-budget";

const feed = { width: 1080, height: 1350 };

describe("headlineBudget", () => {
  it("gives a feed headline room for a real sentence, not six words", () => {
    const budget = headlineBudget({
      placement: { zone: "TOP", scale: "L", maxLines: 3 },
      canvas: feed,
    });
    expect(budget.maxWords).toBeGreaterThanOrEqual(7);
    expect(budget.maxChars).toBeGreaterThanOrEqual(40);
    expect(budget.minWords).toBeLessThan(budget.maxWords);
  });

  it("gives a bigger scale and a narrower zone less room", () => {
    const big = headlineBudget({
      placement: { zone: "TOP", scale: "XL", maxLines: 3 },
      canvas: feed,
    });
    const normal = headlineBudget({
      placement: { zone: "TOP", scale: "M", maxLines: 3 },
      canvas: feed,
    });
    const column = headlineBudget({
      placement: { zone: "LEFT_COLUMN", scale: "M", maxLines: 3 },
      canvas: feed,
    });
    expect(big.maxChars).toBeLessThan(normal.maxChars);
    expect(column.maxChars).toBeLessThan(normal.maxChars);
  });

  it("stays within a punchy range whatever the layout", () => {
    for (const zone of ["TOP", "UPPER_LEFT", "CENTER", "LEFT_COLUMN", "BOTTOM"] as const) {
      for (const scale of ["M", "L", "XL"] as const) {
        for (const maxLines of [1, 3, 5]) {
          for (const canvas of [feed, { width: 1080, height: 566 }, { width: 1080, height: 1920 }]) {
            const budget = headlineBudget({ placement: { zone, scale, maxLines }, canvas });
            expect(budget.maxChars).toBeGreaterThanOrEqual(24);
            expect(budget.maxChars).toBeLessThanOrEqual(56);
            expect(budget.maxWords).toBeGreaterThanOrEqual(4);
            expect(budget.maxWords).toBeLessThanOrEqual(9);
            expect(budget.minWords).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });
});

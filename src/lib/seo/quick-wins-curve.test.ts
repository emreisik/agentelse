import { describe, expect, it } from "vitest";

import type { SearchQueryRow } from "@/lib/module-flows/seo/quick-wins";

import { priorCurve } from "./ctr-curve";
import { MONTH_FACTOR } from "./impact";
import { pickCurveQuickWins } from "./quick-wins-curve";

const CURVE = priorCurve("non-brand");

const row = (
  query: string,
  position: number,
  impressions: number,
  clicks = 0,
): SearchQueryRow => ({ keys: [query], position, impressions, clicks });

describe("pickCurveQuickWins", () => {
  it("keeps positions 4 to 20 inclusive", () => {
    const wins = pickCurveQuickWins(
      [
        row("too high", 3.9, 1000),
        row("first in", 4, 1000),
        row("last in", 20, 1000),
        row("too low", 20.1, 1000),
      ],
      CURVE,
    );
    expect(wins.map((win) => win.query).sort()).toEqual([
      "first in",
      "last in",
    ]);
  });

  it("needs at least 10 impressions", () => {
    const wins = pickCurveQuickWins(
      [row("nine", 12, 9), row("ten", 12, 10)],
      CURVE,
    );
    // Konum 12 → hedef 5 (0.05): 10 × 0.05 × 30/28 ≈ 0.54 → 1.
    expect(wins).toEqual([
      { query: "ten", impressions: 10, clicks: 0, position: 12, gain: 1 },
    ]);
  });

  it("drops a gain under one click a month", () => {
    const wins = pickCurveQuickWins(
      [row("already great", 12, 1000, 60), row("small", 18, 10, 0)],
      CURVE,
    );
    expect(wins.map((win) => win.query)).toEqual(["small"]);
  });

  it("sorts by gain, then impressions", () => {
    const wins = pickCurveQuickWins(
      [
        row("page two", 15, 1000),
        row("edge of page one", 7, 1000),
        // Kazanç eşit (11), gösterimi çok olan önce.
        row("tie b", 15.4, 200, 0),
        row("tie a", 15, 220, 1),
      ],
      CURVE,
    );
    expect(wins.map((win) => win.query)).toEqual([
      "edge of page one",
      "page two",
      "tie a",
      "tie b",
    ]);
    // Konum 7 → hedef 4 (0.07); konum 15 → hedef 5 (0.05).
    expect(wins[0]?.gain).toBe(Math.round(1000 * 0.07 * MONTH_FACTOR));
    expect(wins[1]?.gain).toBe(Math.round(1000 * 0.05 * MONTH_FACTOR));
  });

  it("dedupes by folded text and applies the text filters", () => {
    const wins = pickCurveQuickWins(
      [
        row("Kosu Ayakkabısı", 11, 5000),
        row("koşu ayakkabısı", 12, 4000),
        row("   ", 10, 100),
        row("x".repeat(81), 10, 100),
        row("nan", Number.NaN, 100),
        row("  spaced   query ", 10, 100),
      ],
      CURVE,
    );
    expect(wins.map((win) => win.query)).toEqual([
      "Kosu Ayakkabısı",
      "spaced query",
    ]);
  });

  it("returns at most the limit", () => {
    const rows = Array.from({ length: 14 }, (_, index) =>
      row(`query ${index}`, 10, 1000 - index),
    );
    expect(pickCurveQuickWins(rows, CURVE)).toHaveLength(10);
    expect(pickCurveQuickWins(rows, CURVE, 3)).toHaveLength(3);
  });
});

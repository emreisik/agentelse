import { describe, expect, it } from "vitest";

import type { GscTotals } from "@/lib/seo/totals";

import { lostClicks, moverRows, risingRows, toReportRow } from "./movers";
import type { RankedDeltaLike } from "./types";

function totals(clicks: number, impressions: number, position = 5): GscTotals {
  return { clicks, impressions, positionWeighted: position * impressions };
}

function delta(
  label: string,
  current: GscTotals,
  previous: GscTotals,
  isBrand = false,
): RankedDeltaLike {
  return {
    id: label,
    label,
    url: null,
    isBrand,
    firstSeen: "2026-01-01",
    current,
    previous,
  };
}

describe("toReportRow", () => {
  it("rounds the average position to one decimal", () => {
    const row = toReportRow(
      delta("a", totals(10, 300, 4.26), totals(5, 100, 6.04)),
    );
    expect(row.position).toBe(4.3);
    expect(row.previousPosition).toBe(6);
    expect(row.clicks).toBe(10);
    expect(row.previousClicks).toBe(5);
  });

  it("has no position without impressions", () => {
    const row = toReportRow(delta("a", totals(0, 0), totals(0, 0)));
    expect(row.position).toBeNull();
    expect(row.previousPosition).toBeNull();
  });
});

describe("moverRows", () => {
  const deltas = [
    delta("big win", totals(100, 1000), totals(10, 500)),
    delta("small win", totals(15, 300), totals(10, 300)),
    delta("tiny win", totals(12, 300), totals(10, 300)),
    delta("tie b", totals(30, 300), totals(10, 300)),
    delta("tie a", totals(30, 300), totals(10, 300)),
    delta("big loss", totals(5, 200), totals(105, 900)),
    delta("small loss", totals(7, 200), totals(10, 300)),
    delta("tiny loss", totals(9, 200), totals(10, 300)),
    delta("brand win", totals(200, 400), totals(10, 400), true),
  ];

  it("keeps winners at or above the threshold, biggest first, ties by label", () => {
    const rows = moverRows(deltas, "winners");
    expect(rows.map((row) => row.label)).toEqual([
      "brand win",
      "big win",
      "tie a",
      "tie b",
      "small win",
    ]);
  });

  it("keeps losers at or below the negative threshold, biggest loss first", () => {
    const rows = moverRows(deltas, "losers");
    expect(rows.map((row) => row.label)).toEqual(["big loss", "small loss"]);
  });

  it("drops brand rows with nonBrandOnly", () => {
    const rows = moverRows(deltas, "winners", { nonBrandOnly: true });
    expect(rows.map((row) => row.label)).not.toContain("brand win");
  });

  it("honours the limit and the minimum delta", () => {
    expect(moverRows(deltas, "winners", { limit: 2 })).toHaveLength(2);
    expect(
      moverRows(deltas, "winners", { minDelta: 50 }).map((row) => row.label),
    ).toEqual(["brand win", "big win"]);
  });
});

describe("risingRows", () => {
  const deltas = [
    delta("doubled", totals(5, 100), totals(2, 50)),
    delta("new query", totals(1, 80), totals(0, 0)),
    delta("grew a bit", totals(5, 90), totals(3, 80)),
    delta("too small", totals(1, 19), totals(0, 0)),
    delta("new brand", totals(9, 500), totals(0, 0), true),
    delta("steady big", totals(50, 400), totals(50, 300)),
  ];

  it("keeps new and at-least-doubled searches, most impressions first", () => {
    const rows = risingRows(deltas);
    expect(rows.map((row) => row.label)).toEqual([
      "new brand",
      "doubled",
      "new query",
    ]);
  });

  it("drops brand rows with nonBrandOnly and honours the options", () => {
    expect(
      risingRows(deltas, { nonBrandOnly: true }).map((row) => row.label),
    ).toEqual(["doubled", "new query"]);
    expect(risingRows(deltas, { limit: 1 })).toHaveLength(1);
    expect(
      risingRows(deltas, { minImpressions: 90 }).map((row) => row.label),
    ).toEqual(["new brand", "doubled"]);
  });
});

describe("lostClicks", () => {
  it("sums only the drops", () => {
    expect(
      lostClicks([
        { current: totals(5, 1), previous: totals(15, 1) },
        { current: totals(20, 1), previous: totals(10, 1) },
        { current: totals(0, 1), previous: totals(4, 1) },
      ]),
    ).toBe(14);
    expect(lostClicks([])).toBe(0);
  });
});

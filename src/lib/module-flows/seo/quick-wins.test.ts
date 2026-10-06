import { describe, expect, it } from "vitest";

import {
  cleanQuickWinQuery,
  compactCount,
  pickQuickWins,
  type SearchQueryRow,
} from "./quick-wins";

const row = (
  query: string,
  position: number,
  impressions: number,
  clicks = 1,
): SearchQueryRow => ({ keys: [query], position, impressions, clicks });

describe("pickQuickWins", () => {
  it("keeps queries at position 8-20, most impressions first", () => {
    const wins = pickQuickWins([
      row("page one", 3.2, 9000),
      row("edge of page one", 8, 400),
      row("page two", 14.46, 1200),
      row("last of page two", 20, 50),
      row("page three", 20.1, 5000),
      row("never shown", 12, 0),
    ]);
    expect(wins).toEqual([
      { query: "page two", impressions: 1200, clicks: 1, position: 14.5 },
      { query: "edge of page one", impressions: 400, clicks: 1, position: 8 },
      { query: "last of page two", impressions: 50, clicks: 1, position: 20 },
    ]);
  });

  it("breaks an impressions tie by the better position", () => {
    const wins = pickQuickWins([row("b", 15, 100), row("a", 9, 100)]);
    expect(wins.map((win) => win.query)).toEqual(["a", "b"]);
  });

  it("returns the top 10, one per query however it is written", () => {
    const rows = Array.from({ length: 14 }, (_, index) =>
      row(`query ${index}`, 10, 1000 - index),
    );
    rows.push(
      row("Kosu Ayakkabısı", 11, 5000),
      row("koşu ayakkabısı", 12, 4000),
    );
    const wins = pickQuickWins(rows);
    expect(wins).toHaveLength(10);
    expect(wins[0]?.query).toBe("Kosu Ayakkabısı");
    expect(wins.filter((win) => /ayakkab/i.test(win.query))).toHaveLength(1);
  });

  it("drops empty, overlong and broken rows", () => {
    expect(
      pickQuickWins([
        { keys: [], position: 10, impressions: 100, clicks: 0 },
        row("   ", 10, 100),
        row("x".repeat(81), 10, 100),
        row("nan", Number.NaN, 100),
        row("  spaced   query ", 10, 100),
      ]),
    ).toEqual([
      { query: "spaced query", impressions: 100, clicks: 1, position: 10 },
    ]);
  });
});

describe("cleanQuickWinQuery", () => {
  it("collapses whitespace and rejects empty or overlong text", () => {
    expect(cleanQuickWinQuery("  spaced \n  query ")).toBe("spaced query");
    expect(cleanQuickWinQuery("   ")).toBeNull();
    expect(cleanQuickWinQuery("")).toBeNull();
    expect(cleanQuickWinQuery("x".repeat(80))).toBe("x".repeat(80));
    expect(cleanQuickWinQuery("x".repeat(81))).toBeNull();
    // Kod noktası sayılır: 80 emoji sığar.
    expect(cleanQuickWinQuery("😀".repeat(80))).toBe("😀".repeat(80));
  });

  it("leaves the classic picker without a gain", () => {
    const wins = pickQuickWins([row("page two", 14, 1200)]);
    expect(wins[0]).not.toHaveProperty("gain");
  });
});

describe("compactCount", () => {
  it("shortens big numbers for a chip", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1000)).toBe("1k");
    expect(compactCount(1250)).toBe("1.3k");
    expect(compactCount(48_200)).toBe("48k");
    expect(compactCount(2_000_000)).toBe("2M");
  });
});

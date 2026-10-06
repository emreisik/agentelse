import { describe, expect, it } from "vitest";

import {
  LLM_GOOGLE_STRING_LIMIT,
  limitGoogleStrings,
  takeDistinct,
} from "./llm-budget";

type Item = { id: number; queries: string[] };

const stringsOf = (item: Item) => item.queries;

function items(count: number, perItem: number): Item[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    queries: Array.from({ length: perItem }, (_, k) => `q${id}-${k}`),
  }));
}

function distinct(list: readonly Item[]): number {
  return new Set(list.flatMap((item) => item.queries).filter(Boolean)).size;
}

describe("limitGoogleStrings", () => {
  it("never sends more than 20 distinct strings", () => {
    for (const perItem of [1, 2, 3, 7, 21]) {
      const result = limitGoogleStrings(items(30, perItem), stringsOf);
      expect(distinct(result.items)).toBeLessThanOrEqual(
        LLM_GOOGLE_STRING_LIMIT,
      );
      expect(result.used).toBe(distinct(result.items));
      expect(result.items.length + result.dropped).toBe(30);
    }
  });

  it("does not count a duplicate twice and ignores empty strings", () => {
    const list: Item[] = Array.from({ length: 25 }, (_, id) => ({
      id,
      queries: ["shared", "", id < 19 ? `own-${id}` : "shared"],
    }));
    const result = limitGoogleStrings(list, stringsOf);
    expect(result.items).toHaveLength(25);
    expect(result.used).toBe(20);
    expect(result.dropped).toBe(0);
  });

  it("drops an overflowing item without strip and keeps order", () => {
    const list: Item[] = [
      { id: 1, queries: ["a", "b"] },
      { id: 2, queries: ["c", "d", "e"] },
      { id: 3, queries: ["a", "f"] },
    ];
    const result = limitGoogleStrings(list, stringsOf, { limit: 4 });
    expect(result.items.map((item) => item.id)).toEqual([1, 3]);
    expect(result).toMatchObject({ used: 3, dropped: 1 });
  });

  it("keeps a stripped item with only the allowed strings", () => {
    const list: Item[] = [
      { id: 1, queries: ["a", "b"] },
      { id: 2, queries: ["b", "c", "d"] },
    ];
    const seen: string[][] = [];
    const result = limitGoogleStrings(list, stringsOf, {
      limit: 3,
      strip: (item, allowed) => {
        seen.push([...allowed]);
        return {
          ...item,
          queries: item.queries.filter((value) => allowed.has(value)),
        };
      },
    });
    expect(seen).toEqual([["a", "b"]]);
    expect(result.items).toEqual([
      { id: 1, queries: ["a", "b"] },
      { id: 2, queries: ["b"] },
    ]);
    expect(result).toMatchObject({ used: 2, dropped: 0 });
  });

  it("drops the item when strip returns null", () => {
    const result = limitGoogleStrings(
      [
        { id: 1, queries: ["a"] },
        { id: 2, queries: ["b", "c"] },
      ],
      stringsOf,
      { limit: 2, strip: () => null },
    );
    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.dropped).toBe(1);
  });

  it("never exceeds the limit even when strip leaves new strings", () => {
    const result = limitGoogleStrings(
      [
        { id: 1, queries: ["a"] },
        { id: 2, queries: ["b", "c"] },
      ],
      stringsOf,
      { limit: 2, strip: (item) => item },
    );
    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.used).toBe(1);
  });
});

describe("takeDistinct", () => {
  it("keeps the first distinct non-empty strings in order", () => {
    expect(takeDistinct(["b", "a", "b", "", "c"], 2)).toEqual(["b", "a"]);
    expect(
      takeDistinct(Array.from({ length: 30 }, (_, i) => `s${i}`)),
    ).toHaveLength(20);
  });
});

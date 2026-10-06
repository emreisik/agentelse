import { describe, expect, it } from "vitest";

import { rollupSliceMonth, trimSliceDay, type SliceRow } from "./slices";

// Bu dosyanın kanıtladığı: ülke kırılımı ilk 50'yi tutar, kalanı "other"a
// toplar; satırlar tıklamaya, eşitlikte gösterime göre sıralıdır; cihaz ve
// görünüm kırpılmaz; aylık katlama anahtarları ve "other"ı günler boyunca
// toplar.

function countries(count: number): SliceRow[] {
  return Array.from({ length: count }, (_, index) => [
    `c${index}`,
    index,
    index * 10,
    index * 20,
  ]);
}

describe("trimSliceDay", () => {
  it("keeps the top 50 countries and sums the rest into other", () => {
    const trimmed = trimSliceDay("country", countries(60));
    expect(trimmed.rows).toHaveLength(50);
    expect(trimmed.rows[0]).toEqual(["c59", 59, 590, 1180]);
    // c0..c9 kırpıldı: tıklama 0+…+9 = 45.
    expect(trimmed.other).toEqual([45, 450, 900]);
  });

  it("sorts by clicks, then impressions", () => {
    const trimmed = trimSliceDay("device", [
      ["MOBILE", 5, 10, 1],
      ["DESKTOP", 5, 30, 1],
      ["TABLET", 9, 1, 1],
    ]);
    expect(trimmed.rows.map((row) => row[0])).toEqual([
      "TABLET",
      "DESKTOP",
      "MOBILE",
    ]);
    expect(trimmed.other).toBeNull();
  });

  it("never trims device or appearance rows", () => {
    expect(trimSliceDay("appearance", countries(60)).rows).toHaveLength(60);
    expect(trimSliceDay("country", countries(50)).other).toBeNull();
  });
});

describe("rollupSliceMonth", () => {
  it("sums keys and other across days", () => {
    const rolled = rollupSliceMonth("device", [
      { rows: [["MOBILE", 1, 10, 20]], other: null },
      {
        rows: [
          ["MOBILE", 2, 20, 40],
          ["DESKTOP", 4, 5, 6],
        ],
        other: [1, 1, 1],
      },
    ]);
    expect(rolled.rows).toEqual([
      ["DESKTOP", 4, 5, 6],
      ["MOBILE", 3, 30, 60],
    ]);
    expect(rolled.other).toEqual([1, 1, 1]);
  });

  it("trims the month to the top 50 countries and adds the trimmed rest to other", () => {
    const rolled = rollupSliceMonth("country", [
      { rows: countries(30), other: [2, 2, 2] },
      { rows: countries(60).slice(30), other: null },
    ]);
    expect(rolled.rows).toHaveLength(50);
    expect(rolled.other).toEqual([45 + 2, 450 + 2, 900 + 2]);
  });
});

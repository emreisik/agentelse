import { describe, expect, it } from "vitest";

import { cellToInt, cellToString, rowsToRecords } from "./rows";

describe("rowsToRecords", () => {
  it("zips columns with cells", () => {
    expect(
      rowsToRecords(
        [{ name: "day" }, { name: "events" }],
        [
          ["20261005", 12],
          ["20261006", 7],
        ],
      ),
    ).toEqual([
      { day: "20261005", events: 12 },
      { day: "20261006", events: 7 },
    ]);
  });

  it("tolerates short rows and missing columns", () => {
    expect(
      rowsToRecords([{ name: "a" }, { name: "b" }, { name: "c" }], [["x"], []]),
    ).toEqual([
      { a: "x", b: null, c: null },
      { a: null, b: null, c: null },
    ]);
    expect(rowsToRecords([], [[1, 2]])).toEqual([{}]);
    expect(rowsToRecords([{ name: "a" }], [])).toEqual([]);
  });
});

describe("cell helpers", () => {
  it("reads integers from numbers and numeric strings", () => {
    expect(cellToInt(5)).toBe(5);
    expect(cellToInt("12")).toBe(12);
    expect(cellToInt(7.9)).toBe(7);
    expect(cellToInt("x")).toBe(0);
    expect(cellToInt(null)).toBe(0);
    expect(cellToInt(Number.NaN)).toBe(0);
    expect(cellToInt(undefined)).toBe(0);
  });

  it("reads strings", () => {
    expect(cellToString("a")).toBe("a");
    expect(cellToString(4)).toBe("4");
    expect(cellToString(null)).toBeNull();
    expect(cellToString(true)).toBeNull();
  });
});

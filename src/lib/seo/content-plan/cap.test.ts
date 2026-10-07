import { describe, expect, it } from "vitest";

import {
  capacityOf,
  clampCap,
  DEFAULT_PLAN_SETTINGS,
  parseSettings,
  trimToCapacity,
} from "./cap";

describe("clampCap", () => {
  const table: [unknown, number][] = [
    [undefined, 4],
    [null, 4],
    ["", 4],
    ["  ", 4],
    ["abc", 4],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
    [0, 1],
    [-3, 1],
    [1, 1],
    [4, 4],
    [4.6, 5],
    [4.4, 4],
    [12, 12],
    [13, 12],
    [1000, 12],
    ["7", 7],
    [" 9 ", 9],
    ["13", 12],
    ["0", 1],
    [{}, 4],
  ];
  it.each(table)("clampCap(%j) = %d", (input, expected) => {
    expect(clampCap(input)).toBe(expected);
  });
});

describe("capacityOf and trimToCapacity", () => {
  it("never exceeds the cap for every cap and existing count", () => {
    const items = Array.from({ length: 30 }, (_, index) => index);
    for (let cap = 1; cap <= 12; cap += 1) {
      for (let existing = 0; existing <= 16; existing += 1) {
        const trimmed = trimToCapacity(items, cap, existing);
        expect(trimmed.length).toBe(Math.max(0, cap - existing));
        expect(trimmed.length + Math.min(existing, cap)).toBeLessThanOrEqual(cap);
        expect(capacityOf(cap, existing)).toBe(trimmed.length);
      }
    }
  });

  it("clamps the cap and tolerates odd existing counts", () => {
    expect(capacityOf(99, 0)).toBe(12);
    expect(capacityOf("abc", 1)).toBe(3);
    expect(capacityOf(4, -5)).toBe(4);
    expect(capacityOf(4, 2.9)).toBe(2);
    expect(capacityOf(4, Number.NaN)).toBe(4);
  });

  it("keeps the first items and does not mutate the input", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(trimToCapacity(items, 4, 2)).toEqual(["a", "b"]);
    expect(items).toHaveLength(5);
  });

  it("returns fewer items when fewer were given", () => {
    expect(trimToCapacity(["a"], 4, 0)).toEqual(["a"]);
  });
});

describe("parseSettings", () => {
  it("defaults without a row", () => {
    expect(parseSettings(null)).toEqual({ monthlyCap: 4, autoPlan: true });
    expect(parseSettings(undefined)).toEqual(DEFAULT_PLAN_SETTINGS);
  });

  it("reads a row and repairs bad fields", () => {
    expect(parseSettings({ monthlyCap: 8, autoPlan: false })).toEqual({
      monthlyCap: 8,
      autoPlan: false,
    });
    expect(parseSettings({ monthlyCap: 99, autoPlan: "no" })).toEqual({
      monthlyCap: 12,
      autoPlan: true,
    });
    expect(parseSettings({})).toEqual({ monthlyCap: 4, autoPlan: true });
  });

  it("returns a fresh object each time", () => {
    const a = parseSettings(null);
    a.monthlyCap = 9;
    expect(parseSettings(null).monthlyCap).toBe(4);
  });
});

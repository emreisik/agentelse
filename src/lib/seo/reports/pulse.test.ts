import { describe, expect, it } from "vitest";

import type { SliceRow } from "@/lib/seo/slices";

import {
  biggestSliceChange,
  median,
  pulseNotable,
  usualValue,
} from "./pulse";
import type { SeoReportPulse } from "./types";

function pulse(partial: Partial<SeoReportPulse> = {}): SeoReportPulse {
  return {
    day: "2026-10-05",
    metric: "nonBrandClicks",
    value: 50,
    usual: 50,
    changePct: 0,
    newCritical: 0,
    openCritical: 0,
    biggest: null,
    ...partial,
  };
}

function row(key: string, clicks: number): SliceRow {
  return [key, clicks, clicks * 20, clicks * 20 * 6];
}

describe("median", () => {
  it("is null without values", () => {
    expect(median([])).toBeNull();
  });

  it("takes the middle of an odd count", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it("averages the two middle values of an even count", () => {
    expect(median([4, 1, 3, 10])).toBe(3.5);
    expect(median([5, 1, 3, 9, 7, 2, 8, 4])).toBe(4.5);
  });
});

describe("usualValue", () => {
  it("needs at least three values", () => {
    expect(usualValue([10, 20])).toBeNull();
    expect(usualValue([])).toBeNull();
    expect(usualValue([10, 20, 30])).toBe(20);
    expect(usualValue([10, 20, 30, 40])).toBe(25);
  });
});

describe("pulseNotable", () => {
  it("is notable at -30% with a usual value of 50", () => {
    expect(pulseNotable(pulse({ value: 35, usual: 50 }))).toBe(true);
    expect(pulseNotable(pulse({ value: 65, usual: 50 }))).toBe(true);
  });

  it("is not notable below 30% or below 10 clicks of difference", () => {
    expect(pulseNotable(pulse({ value: 40, usual: 50 }))).toBe(false);
    expect(pulseNotable(pulse({ value: 8, usual: 12 }))).toBe(false);
  });

  it("is not notable with a usual value of 8, however big the swing", () => {
    expect(pulseNotable(pulse({ value: 0, usual: 8 }))).toBe(false);
    expect(pulseNotable(pulse({ value: 30, usual: 8 }))).toBe(false);
  });

  it("is not notable without a usual value", () => {
    expect(pulseNotable(pulse({ value: 500, usual: null }))).toBe(false);
  });

  it("is notable with a new CRITICAL alert alone", () => {
    expect(pulseNotable(pulse({ newCritical: 1 }))).toBe(true);
    expect(pulseNotable(pulse({ usual: null, newCritical: 2 }))).toBe(true);
  });

  it("does not count alerts that are only open", () => {
    expect(pulseNotable(pulse({ openCritical: 3 }))).toBe(false);
  });
});

describe("biggestSliceChange", () => {
  const history = [
    [row("usa", 100), row("uk", 40), row("de", 20)],
    [row("usa", 110), row("uk", 42), row("de", 22)],
    [row("usa", 90), row("uk", 38), row("de", 18)],
    [row("usa", 100), row("uk", 40), row("de", 20)],
  ];

  it("picks the key with the largest absolute change", () => {
    const biggest = biggestSliceChange({
      dimension: "country",
      day: [row("usa", 95), row("uk", 10), row("de", 20)],
      history,
    });
    expect(biggest).toEqual({
      dimension: "country",
      key: "uk",
      value: 10,
      usual: 40,
    });
  });

  it("counts a key that vanished as a drop to zero", () => {
    const biggest = biggestSliceChange({
      dimension: "device",
      day: [row("usa", 100), row("de", 20)],
      history,
    });
    expect(biggest).toMatchObject({ key: "uk", value: 0, usual: 40 });
  });

  it("counts a new key against a usual value of zero", () => {
    const biggest = biggestSliceChange({
      dimension: "country",
      day: [row("usa", 100), row("uk", 40), row("de", 20), row("fr", 70)],
      history,
    });
    expect(biggest).toMatchObject({ key: "fr", value: 70, usual: 0 });
  });

  it("needs at least three history weeks", () => {
    expect(
      biggestSliceChange({
        dimension: "country",
        day: [row("usa", 1)],
        history: history.slice(0, 2),
      }),
    ).toBeNull();
  });

  it("is null when nothing changed", () => {
    expect(
      biggestSliceChange({
        dimension: "country",
        day: [row("usa", 100), row("uk", 40), row("de", 20)],
        history: [history[0]!, history[0]!, history[3]!],
      }),
    ).toBeNull();
  });

  it("ignores the 'other' bucket", () => {
    const biggest = biggestSliceChange({
      dimension: "country",
      day: [row("usa", 100), row("other", 900)],
      history: [
        [row("usa", 100)],
        [row("usa", 100)],
        [row("usa", 100)],
      ],
    });
    expect(biggest).toBeNull();
  });
});

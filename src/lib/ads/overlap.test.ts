import { describe, expect, it } from "vitest";

import {
  overlapKey,
  overlappingPairs,
  targetingSummary,
  type OverlapSubject,
  type TargetingSummary,
} from "./overlap";

function subject(id: string, targeting: Partial<TargetingSummary>, goal = "CONVERSATIONS"): OverlapSubject {
  return {
    externalId: id,
    name: `Ad set ${id}`,
    optimizationGoal: goal,
    targeting: {
      locations: ["TR"],
      ageMin: 25,
      ageMax: 45,
      genders: [],
      customAudiences: [],
      excludedAudiences: [],
      ...targeting,
    },
  };
}

describe("targetingSummary", () => {
  it("keeps only locations, ages, genders and audience ids", () => {
    expect(
      targetingSummary({
        geo_locations: {
          countries: ["tr"],
          cities: [{ key: "2510769", name: "Istanbul", country: "TR", radius: 10 }],
        },
        age_min: 21,
        age_max: 40,
        genders: [2],
        custom_audiences: [{ id: "555", name: "Site visitors" }],
        excluded_custom_audiences: [{ id: "777" }],
        flexible_spec: [{ interests: [{ id: "1", name: "Coffee" }] }],
      }),
    ).toEqual({
      locations: ["TR", "TR:city:2510769"],
      ageMin: 21,
      ageMax: 40,
      genders: [2],
      customAudiences: ["555"],
      excludedAudiences: ["777"],
    });
    expect(targetingSummary(null)).toBeNull();
    expect(targetingSummary({})?.ageMin).toBe(18);
  });
});

describe("overlappingPairs", () => {
  it("finds two broad ad sets after the same people", () => {
    const pairs = overlappingPairs([subject("1", {}), subject("2", { ageMin: 30, ageMax: 50 })]);
    expect(pairs.map((pair) => overlapKey(pair.a.externalId, pair.b.externalId))).toEqual(["1+2"]);
  });

  it("does not compare different goals, countries, ages or genders", () => {
    expect(overlappingPairs([subject("1", {}), subject("2", {}, "LINK_CLICKS")])).toEqual([]);
    expect(overlappingPairs([subject("1", {}), subject("2", { locations: ["DE"] })])).toEqual([]);
    expect(overlappingPairs([subject("1", { ageMin: 18, ageMax: 24 }), subject("2", { ageMin: 45, ageMax: 65 })])).toEqual([]);
    expect(overlappingPairs([subject("1", { genders: [1] }), subject("2", { genders: [2] })])).toEqual([]);
  });

  it("separate cities of one country don't overlap, the whole country does", () => {
    expect(
      overlappingPairs([
        subject("1", { locations: ["TR:city:1"] }),
        subject("2", { locations: ["TR:city:2"] }),
      ]),
    ).toEqual([]);
    expect(
      overlappingPairs([subject("1", { locations: ["TR:city:1"] }), subject("2", { locations: ["TR"] })]),
    ).toHaveLength(1);
  });

  it("respects audiences and exclusions", () => {
    expect(
      overlappingPairs([
        subject("1", { customAudiences: ["a"] }),
        subject("2", { customAudiences: ["b"] }),
      ]),
    ).toEqual([]);
    expect(
      overlappingPairs([
        subject("1", { customAudiences: ["a"] }),
        subject("2", { excludedAudiences: ["a"] }),
      ]),
    ).toEqual([]);
    expect(
      overlappingPairs([subject("1", { customAudiences: ["a", "c"] }), subject("2", { customAudiences: ["c"] })]),
    ).toHaveLength(1);
  });
});

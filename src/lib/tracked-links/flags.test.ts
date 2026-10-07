import { describe, expect, it } from "vitest";

import { utmFeatureOn } from "./flags";

describe("utmFeatureOn", () => {
  it("is on only for the exact string 'true'", () => {
    expect(utmFeatureOn({ GA_UTM: "true" })).toBe(true);
    for (const value of ["", "1", "TRUE", "True", "false", undefined]) {
      expect(utmFeatureOn({ GA_UTM: value })).toBe(false);
    }
  });

  it("reads process.env at call time", () => {
    const saved = process.env.GA_UTM;
    try {
      process.env.GA_UTM = "true";
      expect(utmFeatureOn()).toBe(true);
      process.env.GA_UTM = "false";
      expect(utmFeatureOn()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GA_UTM;
      else process.env.GA_UTM = saved;
    }
  });
});

import { describe, expect, it } from "vitest";

import { reportShareOn } from "./flags";

// GSC_AGENCY ya da GA_AGENCY tam "true" ise açık; başka her değer kapalı.
describe("reportShareOn", () => {
  it("is on when either track's flag is exactly true", () => {
    expect(reportShareOn({ GSC_AGENCY: "true" })).toBe(true);
    expect(reportShareOn({ GA_AGENCY: "true" })).toBe(true);
    expect(reportShareOn({ GSC_AGENCY: "true", GA_AGENCY: "true" })).toBe(true);
  });

  it("is off when both are missing or not exactly true", () => {
    expect(reportShareOn({})).toBe(false);
    expect(reportShareOn({ GSC_AGENCY: "TRUE", GA_AGENCY: "1" })).toBe(false);
    expect(reportShareOn({ GSC_AGENCY: " true", GA_AGENCY: "yes" })).toBe(false);
    expect(reportShareOn({ GSC_AGENCY: "false", GA_AGENCY: "" })).toBe(false);
  });

  it("reads process.env at call time", () => {
    const saved = { gsc: process.env.GSC_AGENCY, ga: process.env.GA_AGENCY };
    try {
      process.env.GSC_AGENCY = "false";
      process.env.GA_AGENCY = "false";
      expect(reportShareOn()).toBe(false);
      process.env.GA_AGENCY = "true";
      expect(reportShareOn()).toBe(true);
    } finally {
      if (saved.gsc === undefined) delete process.env.GSC_AGENCY;
      else process.env.GSC_AGENCY = saved.gsc;
      if (saved.ga === undefined) delete process.env.GA_AGENCY;
      else process.env.GA_AGENCY = saved.ga;
    }
  });
});

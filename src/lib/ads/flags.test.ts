import { afterEach, describe, expect, it } from "vitest";

import { AdsFlags, flagValue } from "./flags";

describe("Meta Ads flags", () => {
  afterEach(() => {
    delete process.env.META_ADS_SYNC;
    delete process.env.META_ADS_OPTIMIZER;
  });

  it("opens on true in any case and ignores surrounding spaces", () => {
    for (const value of ["true", "TRUE", "True", " true ", "tRuE\n"]) {
      process.env.META_ADS_SYNC = value;
      expect(AdsFlags.sync(), JSON.stringify(value)).toBe(true);
    }
  });

  it("stays closed for anything else", () => {
    for (const value of [undefined, "", "false", "1", "yes", "on", "truee"]) {
      if (value === undefined) delete process.env.META_ADS_SYNC;
      else process.env.META_ADS_SYNC = value;
      expect(AdsFlags.sync(), JSON.stringify(value)).toBe(false);
    }
  });

  it("reads the optimizer mode the same way", () => {
    process.env.META_ADS_OPTIMIZER = " SHADOW ";
    expect(AdsFlags.optimizer()).toBe("shadow");
    process.env.META_ADS_OPTIMIZER = "On";
    expect(AdsFlags.optimizer()).toBe("on");
    process.env.META_ADS_OPTIMIZER = "maybe";
    expect(AdsFlags.optimizer()).toBe("off");
    delete process.env.META_ADS_OPTIMIZER;
    expect(AdsFlags.optimizer()).toBe("off");
  });

  it("normalises a raw value", () => {
    expect(flagValue(undefined)).toBe("");
    expect(flagValue("  TrUe ")).toBe("true");
  });
});

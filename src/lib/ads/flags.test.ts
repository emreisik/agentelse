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

describe("ready recipes override (META_ADS_READY_RECIPES)", () => {
  afterEach(() => {
    delete process.env.META_ADS_READY_RECIPES;
  });

  it("opens a closed recipe from the environment, known keys only", async () => {
    const { recipeReady } = await import("./objectives");
    expect(recipeReady("leads_instant_form")).toBe(false);
    process.env.META_ADS_READY_RECIPES = " Leads_Instant_Form , nonsense ";
    expect(recipeReady("leads_instant_form")).toBe(true);
    expect(recipeReady("sales_purchase")).toBe(false);
    expect(recipeReady("nonsense")).toBe(false);
    // Instagram profil ziyareti de kapalı gelir ve aynı yoldan açılır.
    expect(recipeReady("traffic_instagram_profile")).toBe(false);
    process.env.META_ADS_READY_RECIPES = "traffic_instagram_profile";
    expect(recipeReady("traffic_instagram_profile")).toBe(true);
    // Hazır olanlar etkilenmez.
    expect(recipeReady("traffic_link_clicks")).toBe(true);
  });
});

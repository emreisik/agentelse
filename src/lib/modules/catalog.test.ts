import { describe, expect, it } from "vitest";

import { CHANNEL_KEYS, CHANNELS } from "@/lib/content-channels";

import {
  MODULE_KEYS,
  MODULES,
  isModuleKey,
  parseModuleKey,
  type ModuleKey,
} from "./catalog";

describe("MODULES", () => {
  it("lists the four modules in launcher order, each under its own key", () => {
    expect(MODULE_KEYS).toEqual(["social", "ads", "analytics", "seo"]);
    expect(Object.keys(MODULES)).toEqual([...MODULE_KEYS]);
    for (const key of MODULE_KEYS) expect(MODULES[key].key).toBe(key);
  });

  it("names each module and the verb of its last step", () => {
    const rows = MODULE_KEYS.map((key) => [
      key,
      MODULES[key].label,
      MODULES[key].deliverLabel,
    ]);
    expect(rows).toEqual([
      ["social", "Social Media Planner", "Publish"],
      ["ads", "Ads Manager", "Launch"],
      ["analytics", "Analytics", "Share"],
      ["seo", "SEO Manager", "Publish"],
    ]);
  });

  it("every module is built and ready (P5-P7)", () => {
    expect(MODULE_KEYS.filter((key) => MODULES[key].ready)).toEqual([
      ...MODULE_KEYS,
    ]);
  });

  it("gives every module one short line", () => {
    for (const key of MODULE_KEYS) {
      const { blurb } = MODULES[key];
      expect(blurb.trim()).toBe(blurb);
      expect(blurb.length).toBeGreaterThan(10);
      expect(blurb.length).toBeLessThanOrEqual(60);
      expect(blurb).not.toContain("\n");
    }
  });

  it("social goes to every social channel of the catalog; ads and SEO to their own", () => {
    expect(MODULES.social.channels).toEqual(
      CHANNEL_KEYS.filter((key) => CHANNELS[key].group === "social"),
    );
    expect(MODULES.social.channels).toEqual([
      "instagram",
      "facebook",
      "tiktok",
      "linkedin",
      "x",
    ]);
    expect(MODULES.ads.channels).toEqual(["ads"]);
    expect(MODULES.seo.channels).toEqual(["seo"]);
    expect(MODULES.analytics.channels).toEqual([]);
  });
});

describe("isModuleKey / parseModuleKey", () => {
  it.each(["social", "ads", "analytics", "seo"])("%s is a module", (value) => {
    expect(isModuleKey(value)).toBe(true);
    expect(parseModuleKey(value)).toBe(value as ModuleKey);
  });

  it.each([
    ["a capitalised key", "Social"],
    ["padding", " ads"],
    ["an empty string", ""],
    ["a channel", "instagram"],
    ["a general chat", "general"],
    ["an object property name", "toString"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["an array", ["social"]],
  ])("%s is no module (a general chat)", (_label, value) => {
    expect(isModuleKey(value)).toBe(false);
    expect(parseModuleKey(value)).toBeNull();
  });
});

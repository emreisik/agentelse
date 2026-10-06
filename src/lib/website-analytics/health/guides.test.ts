import { describe, expect, it } from "vitest";

import { GA_GUIDE_LINK_ROOTS, GA_GUIDES, gaGuide } from "./guides";
import { GA_CHECKS } from "./registry";

// Bu dosyanın kanıtladığı (GA-F3 rehberleri): kayıttaki her guideId'nin
// 3–6 adımlı bir rehberi var; bağlantılar yalnız izinli köklerle başlar ve
// adım metninde adres yok.

describe("GA_GUIDES", () => {
  it("has a guide with 3–6 steps for every check's guideId", () => {
    for (const def of GA_CHECKS) {
      const guide = gaGuide(def.guideId);
      expect(guide, def.guideId).not.toBeNull();
      expect(guide?.id).toBe(def.guideId);
      expect(guide?.title.trim()).not.toBe("");
      expect(guide?.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide?.steps.length).toBeLessThanOrEqual(6);
    }
  });

  it("links only to the allowed roots", () => {
    for (const guide of Object.values(GA_GUIDES)) {
      for (const link of guide.links) {
        expect(
          GA_GUIDE_LINK_ROOTS.some((root) => link.href.startsWith(root)),
          link.href,
        ).toBe(true);
        expect(link.label.trim()).not.toBe("");
      }
    }
  });

  it("keeps addresses out of the step text", () => {
    for (const guide of Object.values(GA_GUIDES)) {
      for (const step of guide.steps) expect(step).not.toMatch(/http/i);
    }
  });

  it("returns null for an unknown guide", () => {
    expect(gaGuide("ga-mh99")).toBeNull();
    expect(gaGuide("toString")).toBeNull();
  });

  it("covers the plan's fix wording", () => {
    expect(gaGuide("ga-mh5")?.where).toBe("Admin → Data display → Events");
    expect(gaGuide("ga-mh5")?.steps.join(" ")).toContain("Mark as key event");
    expect(gaGuide("ga-mh10")?.where).toContain("List unwanted referrals");
    expect(gaGuide("ga-mh12")?.steps.join(" ")).toContain("I fixed it");
    expect(gaGuide("ga-mh14")?.steps.join(" ")).toContain("14 months");
    expect(gaGuide("ga-mh23")?.steps.join(" ")).toContain("not legal advice");
  });
});

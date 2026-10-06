import { describe, expect, it } from "vitest";

import { SEARCH_ALERT_KIND_NAMES } from "./alert-kinds";
import { SEARCH_HEALTH_GUIDES, guideFor } from "./guides";

describe("search health guides", () => {
  it("has 3 to 6 English steps for every kind", () => {
    for (const kind of SEARCH_ALERT_KIND_NAMES) {
      const guide = SEARCH_HEALTH_GUIDES[kind];
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.steps.length).toBeLessThanOrEqual(6);
    }
  });

  it("links only to Google's own documentation", () => {
    for (const kind of SEARCH_ALERT_KIND_NAMES) {
      const url = SEARCH_HEALTH_GUIDES[kind].learnMoreUrl;
      if (url === null) continue;
      expect(url).toMatch(
        /^https:\/\/(developers\.google\.com\/search|support\.google\.com\/)/,
      );
    }
  });

  it("has no placeholders or user data", () => {
    for (const kind of SEARCH_ALERT_KIND_NAMES) {
      for (const step of SEARCH_HEALTH_GUIDES[kind].steps) {
        expect(step).not.toMatch(/[{}<>]|%s|\$\{/);
        expect(step.trim()).not.toMatch(/^\d+$/);
        // Tek sayı izni: kalıcı yönlendirme kodu.
        expect(step.replace("(301)", "")).not.toMatch(/\d/);
      }
    }
  });

  it("explains the redirect map for lost URLs", () => {
    expect(SEARCH_HEALTH_GUIDES.GSC_LOST_URLS.steps.join(" ")).toMatch(
      /redirect map/,
    );
    expect(guideFor("UNKNOWN").steps.length).toBeGreaterThanOrEqual(3);
  });
});

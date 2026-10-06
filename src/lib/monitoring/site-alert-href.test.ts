import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSiteAlertSource,
  SITE_ALERT_DEDUPE_PREFIX,
  SITE_ALERT_SOURCES,
  siteAlertHref,
} from "./site-alert-href";

// Bu dosyanın kanıtladığı: bağlantılar kaynağa ve Website sayfası bayrağına
// göre seçilir ve modül ortam değişkeni okuyan hiçbir şeyi içe aktarmaz
// (istemci ve journey kodu güvenle kullanır).

describe("site alert hrefs", () => {
  it("links GA4 to the Website panel or the Integrations dialog", () => {
    expect(
      siteAlertHref({ source: "GA4", projectId: "p1", websitePage: true }),
    ).toBe("/projects/p1/site#measurement-health");
    expect(
      siteAlertHref({ source: "GA4", projectId: "p1", websitePage: false }),
    ).toBe("/projects/p1/integrations?integration=google_analytics");
  });

  it("links GSC and SEO to the Search health section", () => {
    for (const source of ["GSC", "SEO"] as const) {
      for (const websitePage of [true, false]) {
        expect(siteAlertHref({ source, projectId: "p1", websitePage })).toBe(
          "/projects/p1/arama#health",
        );
      }
    }
  });

  it("recognises only the three sources", () => {
    expect(SITE_ALERT_SOURCES).toEqual(["GA4", "GSC", "SEO"]);
    for (const source of SITE_ALERT_SOURCES) {
      expect(isSiteAlertSource(source)).toBe(true);
    }
    for (const value of [null, undefined, "", "ga4", "META", 4]) {
      expect(isSiteAlertSource(value)).toBe(false);
    }
    expect(SITE_ALERT_DEDUPE_PREFIX).toEqual({
      GA4: "ga4:",
      GSC: "gsc:",
      SEO: "seo:",
    });
  });

  it("imports nothing (no env, no app-url)", () => {
    const source = readFileSync(
      path.join(__dirname, "site-alert-href.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toContain("@/lib/env");
    expect(source).not.toContain("app-url");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SeoReportFlags,
  seoReportsActiveFor,
  seoReportsAllowedFor,
  seoReportsOn,
} from "./flags";

// Bu dosyanın kanıtladığı: rapor bayrağı yalnız SEO_REPORTS ve GSC_SYNC ikisi
// de tam "true" iken açar; proje izni W1'in geliştirme korumasını izler.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seoReportsOn", () => {
  it("needs both flags to be exactly true", () => {
    expect(seoReportsOn({ SEO_REPORTS: "true", GSC_SYNC: "true" })).toBe(true);
    expect(seoReportsOn({ SEO_REPORTS: "true" })).toBe(false);
    expect(seoReportsOn({ GSC_SYNC: "true" })).toBe(false);
    expect(seoReportsOn({ SEO_REPORTS: "1", GSC_SYNC: "true" })).toBe(false);
    expect(seoReportsOn({ SEO_REPORTS: "true", GSC_SYNC: "TRUE" })).toBe(false);
    expect(seoReportsOn({})).toBe(false);
  });

  it("SeoReportFlags reads the environment at call time", () => {
    vi.stubEnv("SEO_REPORTS", "true");
    vi.stubEnv("GSC_SYNC", "false");
    expect(SeoReportFlags.on()).toBe(false);
    vi.stubEnv("GSC_SYNC", "true");
    expect(SeoReportFlags.on()).toBe(true);
    vi.stubEnv("SEO_REPORTS", "");
    expect(SeoReportFlags.on()).toBe(false);
  });
});

describe("seoReportsAllowedFor", () => {
  it("allows only the dev list on a shared database", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GSC_SYNC_DEV_PROJECTS: "proj-a",
    };
    expect(seoReportsAllowedFor("proj-a", env)).toBe(true);
    expect(seoReportsAllowedFor("proj-b", env)).toBe(false);
  });

  it("restricts to the rollout list everywhere", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: LIVE,
      GSC_ROLLOUT_PROJECTS: "proj-a",
    };
    expect(seoReportsAllowedFor("proj-a", env)).toBe(true);
    expect(seoReportsAllowedFor("proj-b", env)).toBe(false);
  });
});

describe("seoReportsActiveFor", () => {
  const production = { NODE_ENV: "production", DATABASE_URL: LIVE };

  it("is off without the flags even for an allowed project", () => {
    expect(seoReportsActiveFor("proj-a", production)).toBe(false);
  });

  it("needs the flags and the project allow-list together", () => {
    const flags = { ...production, SEO_REPORTS: "true", GSC_SYNC: "true" };
    expect(seoReportsActiveFor("proj-a", flags)).toBe(true);
    const restricted = { ...flags, GSC_ROLLOUT_PROJECTS: "proj-a" };
    expect(seoReportsActiveFor("proj-a", restricted)).toBe(true);
    expect(seoReportsActiveFor("proj-b", restricted)).toBe(false);
    const dev = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      SEO_REPORTS: "true",
      GSC_SYNC: "true",
    };
    expect(seoReportsActiveFor("proj-a", dev)).toBe(false);
  });
});

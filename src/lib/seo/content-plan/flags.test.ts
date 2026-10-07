import { afterEach, describe, expect, it, vi } from "vitest";

import {
  seoContentPlanActiveFor,
  seoContentPlanOn,
  SeoContentPlanFlags,
} from "./flags";

// Bu dosyanın kanıtladığı: plan yalnız dört bayrak birlikte açıkken çalışır
// (yalnız tam "true" / "on"), çağrı anında okunur ve proje izin listesine uyar.

const ALL_ON = {
  SEO_CONTENT_PLAN: "true",
  GSC_SYNC: "true",
  SEO_INSIGHTS: "on",
  GSC_SEARCH_PAGE: "true",
  NODE_ENV: "production",
};

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seoContentPlanOn", () => {
  it("is on only when all four flags are on", () => {
    expect(seoContentPlanOn(ALL_ON)).toBe(true);
  });

  it("SEO_CONTENT_PLAN alone is not enough", () => {
    expect(seoContentPlanOn({ SEO_CONTENT_PLAN: "true" })).toBe(false);
    expect(seoContentPlanOn({ ...ALL_ON, GSC_SYNC: undefined })).toBe(false);
    expect(seoContentPlanOn({ ...ALL_ON, SEO_INSIGHTS: undefined })).toBe(false);
    expect(seoContentPlanOn({ ...ALL_ON, GSC_SEARCH_PAGE: undefined })).toBe(false);
    expect(seoContentPlanOn({ ...ALL_ON, SEO_CONTENT_PLAN: undefined })).toBe(false);
  });

  it("shadow and off insights keep it off", () => {
    expect(seoContentPlanOn({ ...ALL_ON, SEO_INSIGHTS: "shadow" })).toBe(false);
    expect(seoContentPlanOn({ ...ALL_ON, SEO_INSIGHTS: "off" })).toBe(false);
  });

  it("only the exact value counts", () => {
    for (const value of ["TRUE", "1", "yes", " true", "false", ""]) {
      expect(seoContentPlanOn({ ...ALL_ON, SEO_CONTENT_PLAN: value })).toBe(false);
      expect(seoContentPlanOn({ ...ALL_ON, GSC_SYNC: value })).toBe(false);
      expect(seoContentPlanOn({ ...ALL_ON, GSC_SEARCH_PAGE: value })).toBe(false);
    }
    expect(seoContentPlanOn({ ...ALL_ON, SEO_INSIGHTS: "ON" })).toBe(false);
  });
});

describe("SeoContentPlanFlags", () => {
  it("reads the environment at call time", () => {
    vi.stubEnv("SEO_CONTENT_PLAN", "true");
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_SEARCH_PAGE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(SeoContentPlanFlags.on()).toBe(true);
    vi.stubEnv("SEO_CONTENT_PLAN", "false");
    expect(SeoContentPlanFlags.on()).toBe(false);
  });
});

describe("seoContentPlanActiveFor", () => {
  it("adds the project allow-list from GSC_ROLLOUT_PROJECTS", () => {
    const env = { ...ALL_ON, GSC_ROLLOUT_PROJECTS: "proj-a" };
    expect(seoContentPlanActiveFor("proj-a", env)).toBe(true);
    expect(seoContentPlanActiveFor("proj-b", env)).toBe(false);
  });

  it("a dev process on the shared database only runs listed projects", () => {
    const env = {
      ...ALL_ON,
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GSC_SYNC_DEV_PROJECTS: "proj-a",
    };
    expect(seoContentPlanActiveFor("proj-a", env)).toBe(true);
    expect(seoContentPlanActiveFor("proj-b", env)).toBe(false);
  });

  it("is false for every project when the flags are off", () => {
    expect(seoContentPlanActiveFor("proj-a", { ...ALL_ON, SEO_CONTENT_PLAN: "false" })).toBe(false);
  });

  it("without a rollout list every project is allowed in production", () => {
    expect(seoContentPlanActiveFor("anything", ALL_ON)).toBe(true);
  });
});

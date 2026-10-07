import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SeoApplyFlags,
  applyMockMode,
  mockMatchesSite,
  seoApplyEnabled,
  seoApplyEnabledFor,
  seoApplyGlobalWorkAllowedHere,
  seoApplyRestrictedProjects,
  seoGeoEnabled,
  seoGeoEnabledFor,
  seoGeoTrafficEnabled,
  seoIndexNowEnabled,
} from "./flags";

// Bu dosyanın kanıtladığı: bayraklar çağrı anında okunur, yalnız "true" açar;
// alt bayraklar üst bayraksız açılmaz; canlı veritabanını paylaşan geliştirme
// süreci yalnız SEO_DEV_PROJECTS'teki projelere yazar.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SC-F8 flags", () => {
  const cases = [
    ["SEO_APPLY", SeoApplyFlags.apply],
    ["SEO_INDEXNOW", SeoApplyFlags.indexNow],
    ["SEO_GEO", SeoApplyFlags.geo],
  ] as const;

  it.each(cases)("%s is read at call time and only 'true' turns it on", (name, flag) => {
    vi.stubEnv(name, "");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "1");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "TRUE");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "true");
    expect(flag()).toBe(true);
    vi.stubEnv(name, "false");
    expect(flag()).toBe(false);
  });

  it("apply needs SEO_HEALTH", () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_HEALTH", "");
    expect(seoApplyEnabled()).toBe(false);
    vi.stubEnv("SEO_HEALTH", "true");
    expect(seoApplyEnabled()).toBe(true);
  });

  it("IndexNow needs SEO_APPLY (and with it SEO_HEALTH)", () => {
    vi.stubEnv("SEO_INDEXNOW", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    expect(seoIndexNowEnabled()).toBe(false);
    vi.stubEnv("SEO_APPLY", "true");
    expect(seoIndexNowEnabled()).toBe(true);
    vi.stubEnv("SEO_HEALTH", "");
    expect(seoIndexNowEnabled()).toBe(false);
  });

  it("GEO needs SEO_HEALTH and SEO_CRAWL", () => {
    vi.stubEnv("SEO_GEO", "true");
    expect(seoGeoEnabled()).toBe(false);
    vi.stubEnv("SEO_HEALTH", "true");
    expect(seoGeoEnabled()).toBe(false);
    vi.stubEnv("SEO_CRAWL", "true");
    expect(seoGeoEnabled()).toBe(true);
    vi.stubEnv("SEO_GEO", "false");
    expect(seoGeoEnabled()).toBe(false);
  });

  it("AI traffic needs GA_SYNC on top of GEO", () => {
    vi.stubEnv("SEO_GEO", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_CRAWL", "true");
    expect(seoGeoTrafficEnabled()).toBe(false);
    vi.stubEnv("GA_SYNC", "true");
    expect(seoGeoTrafficEnabled()).toBe(true);
    vi.stubEnv("SEO_GEO", "");
    expect(seoGeoTrafficEnabled()).toBe(false);
  });
});

describe("per project gates", () => {
  const dev = {
    NODE_ENV: "development",
    DATABASE_URL: LIVE,
    SEO_DEV_PROJECTS: "proj-a, proj-b",
  };

  it("honours SEO_DEV_PROJECTS in a development process on the shared database", () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_GEO", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_CRAWL", "true");
    expect(seoApplyEnabledFor("proj-a", dev)).toBe(true);
    expect(seoApplyEnabledFor("proj-c", dev)).toBe(false);
    expect(seoGeoEnabledFor("proj-b", dev)).toBe(true);
    expect(seoGeoEnabledFor("proj-c", dev)).toBe(false);
    expect(seoApplyGlobalWorkAllowedHere(dev)).toBe(false);
    expect(seoApplyRestrictedProjects(dev)).toEqual(["proj-a", "proj-b"]);
  });

  it("honours SEO_ROLLOUT_PROJECTS in production", () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    const prod = {
      NODE_ENV: "production",
      DATABASE_URL: LIVE,
      SEO_ROLLOUT_PROJECTS: "proj-x",
    };
    expect(seoApplyEnabledFor("proj-x", prod)).toBe(true);
    expect(seoApplyEnabledFor("proj-y", prod)).toBe(false);
    expect(seoApplyRestrictedProjects(prod)).toEqual(["proj-x"]);
  });

  it("is off for every project when the flag is off", () => {
    vi.stubEnv("SEO_APPLY", "");
    vi.stubEnv("SEO_HEALTH", "true");
    expect(seoApplyEnabledFor("proj-a", { NODE_ENV: "production" })).toBe(false);
  });

  it("runs everywhere in production without lists", () => {
    expect(seoApplyRestrictedProjects({ NODE_ENV: "production" })).toBeNull();
    expect(seoApplyGlobalWorkAllowedHere({ NODE_ENV: "production" })).toBe(true);
  });
});

describe("mock mode", () => {
  it("reads AGENTELSE_PROVIDER_MODE", () => {
    expect(applyMockMode({ AGENTELSE_PROVIDER_MODE: "mock" })).toBe(true);
    expect(applyMockMode({ AGENTELSE_PROVIDER_MODE: "live" })).toBe(false);
    expect(applyMockMode({})).toBe(false);
  });

  it("mockMatchesSite truth table", () => {
    expect(mockMatchesSite(true, true)).toBe(true);
    expect(mockMatchesSite(true, false)).toBe(false);
    expect(mockMatchesSite(false, false)).toBe(true);
    expect(mockMatchesSite(false, true)).toBe(false);
  });
});

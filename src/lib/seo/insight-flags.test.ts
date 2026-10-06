import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SeoInsightFlags,
  seoEngineOwnsProject,
  seoInsightsAllowedFor,
  seoInsightsMode,
} from "./insight-flags";

// Bu dosyanın kanıtladığı: yalnız tam "on"/"shadow" açar; motor GSC_SYNC
// olmadan çalışmaz; izin listesi GSC'ninkiyle aynıdır; shadow projeyi
// sahiplenmez.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seoInsightsMode", () => {
  it("accepts only the exact lowercase values", () => {
    const cases: [string, string][] = [
      ["on", "on"],
      ["shadow", "shadow"],
      ["ON", "off"],
      ["true", "off"],
      ["", "off"],
    ];
    for (const [value, mode] of cases) {
      expect(seoInsightsMode({ SEO_INSIGHTS: value })).toBe(mode);
    }
    expect(seoInsightsMode({})).toBe("off");
  });
});

describe("SeoInsightFlags", () => {
  it("needs GSC_SYNC for active and userFacing", () => {
    expect(SeoInsightFlags.active({ SEO_INSIGHTS: "on" })).toBe(false);
    expect(SeoInsightFlags.userFacing({ SEO_INSIGHTS: "on" })).toBe(false);
    const sync = { GSC_SYNC: "true" };
    expect(SeoInsightFlags.active({ ...sync, SEO_INSIGHTS: "shadow" })).toBe(
      true,
    );
    expect(
      SeoInsightFlags.userFacing({ ...sync, SEO_INSIGHTS: "shadow" }),
    ).toBe(false);
    expect(SeoInsightFlags.active({ ...sync, SEO_INSIGHTS: "on" })).toBe(true);
    expect(SeoInsightFlags.userFacing({ ...sync, SEO_INSIGHTS: "on" })).toBe(
      true,
    );
    expect(SeoInsightFlags.active({ ...sync, SEO_INSIGHTS: "off" })).toBe(
      false,
    );
  });

  it("reads the environment at call time", () => {
    vi.stubEnv("SEO_INSIGHTS", "off");
    vi.stubEnv("GSC_SYNC", "true");
    expect(SeoInsightFlags.mode()).toBe("off");
    expect(SeoInsightFlags.active()).toBe(false);
    vi.stubEnv("SEO_INSIGHTS", "shadow");
    expect(SeoInsightFlags.mode()).toBe("shadow");
    expect(SeoInsightFlags.active()).toBe(true);
    expect(SeoInsightFlags.userFacing()).toBe(false);
    vi.stubEnv("SEO_INSIGHTS", "on");
    expect(SeoInsightFlags.userFacing()).toBe(true);
    vi.stubEnv("GSC_SYNC", "false");
    expect(SeoInsightFlags.userFacing()).toBe(false);
  });
});

describe("seoInsightsAllowedFor", () => {
  it("follows the GSC dev and rollout lists", () => {
    const dev = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GSC_SYNC_DEV_PROJECTS: "proj-a",
    };
    expect(seoInsightsAllowedFor("proj-a", dev)).toBe(true);
    expect(seoInsightsAllowedFor("proj-b", dev)).toBe(false);
    const rollout = {
      NODE_ENV: "production",
      DATABASE_URL: LIVE,
      GSC_ROLLOUT_PROJECTS: "proj-b",
    };
    expect(seoInsightsAllowedFor("proj-a", rollout)).toBe(false);
    expect(seoInsightsAllowedFor("proj-b", rollout)).toBe(true);
    expect(
      seoInsightsAllowedFor("proj-z", {
        NODE_ENV: "production",
        DATABASE_URL: LIVE,
      }),
    ).toBe(true);
  });
});

describe("seoEngineOwnsProject", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: LIVE, GSC_SYNC: "true" };

  it("owns allowed projects only in mode on", () => {
    expect(seoEngineOwnsProject("p", { ...base, SEO_INSIGHTS: "on" })).toBe(
      true,
    );
    expect(seoEngineOwnsProject("p", { ...base, SEO_INSIGHTS: "shadow" })).toBe(
      false,
    );
    expect(seoEngineOwnsProject("p", { ...base, SEO_INSIGHTS: "off" })).toBe(
      false,
    );
    expect(
      seoEngineOwnsProject("p", {
        ...base,
        SEO_INSIGHTS: "on",
        GSC_ROLLOUT_PROJECTS: "other",
      }),
    ).toBe(false);
    expect(
      seoEngineOwnsProject("p", {
        ...base,
        GSC_SYNC: "false",
        SEO_INSIGHTS: "on",
      }),
    ).toBe(false);
  });
});

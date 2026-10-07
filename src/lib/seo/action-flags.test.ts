import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SeoActionFlags,
  seoActionsAllowedFor,
  seoActionsGlobalWorkAllowedHere,
  seoActionsRestrictedProjects,
} from "./action-flags";
import {
  seoGlobalWorkAllowedHere,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "./health-flags";

// Bu dosyanın kanıtladığı: bayraklar çağrı anında okunur ve yalnız tam
// "true" açar; döngü bayrağı SEO_HEALTH + SEO_CRAWL ister; izin listesi
// yardımcıları W2'ye birebir devreder.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoActionFlags", () => {
  it("manager only turns on with the exact value", () => {
    vi.stubEnv("SEO_ACTIONS", "");
    expect(SeoActionFlags.manager()).toBe(false);
    for (const value of ["TRUE", "1", "on", "yes", " true"]) {
      vi.stubEnv("SEO_ACTIONS", value);
      expect(SeoActionFlags.manager()).toBe(false);
    }
    vi.stubEnv("SEO_ACTIONS", "true");
    expect(SeoActionFlags.manager()).toBe(true);
  });

  it("loop needs SEO_ACTIONS, SEO_HEALTH and SEO_CRAWL", () => {
    vi.stubEnv("SEO_ACTIONS", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_CRAWL", "");
    expect(SeoActionFlags.loop()).toBe(false);
    vi.stubEnv("SEO_CRAWL", "true");
    expect(SeoActionFlags.loop()).toBe(true);
    vi.stubEnv("SEO_HEALTH", "");
    expect(SeoActionFlags.loop()).toBe(false);
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_ACTIONS", "");
    expect(SeoActionFlags.loop()).toBe(false);
  });

  it("reads the environment at call time", () => {
    vi.stubEnv("SEO_ACTIONS", "true");
    expect(SeoActionFlags.manager()).toBe(true);
    vi.stubEnv("SEO_ACTIONS", "false");
    expect(SeoActionFlags.manager()).toBe(false);
  });
});

describe("allow-list helpers", () => {
  it("a dev process touches only SEO_DEV_PROJECTS", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      SEO_DEV_PROJECTS: "p1, p2",
    };
    expect(seoActionsAllowedFor("p1", env)).toBe(true);
    expect(seoActionsAllowedFor("p3", env)).toBe(false);
    expect(seoActionsRestrictedProjects(env)).toEqual(["p1", "p2"]);
    expect(seoActionsGlobalWorkAllowedHere(env)).toBe(false);
  });

  it("honours the rollout list in every environment", () => {
    const env = { NODE_ENV: "production", SEO_ROLLOUT_PROJECTS: "p9" };
    expect(seoActionsAllowedFor("p9", env)).toBe(true);
    expect(seoActionsAllowedFor("p1", env)).toBe(false);
    expect(seoActionsRestrictedProjects(env)).toEqual(["p9"]);
    expect(seoActionsGlobalWorkAllowedHere(env)).toBe(true);
  });

  it("delegates to the W2 helpers", () => {
    const env = { NODE_ENV: "production" };
    expect(seoActionsAllowedFor("x", env)).toBe(seoWorkAllowedFor("x", env));
    expect(seoActionsRestrictedProjects(env)).toEqual(
      seoRestrictedProjects(env),
    );
    expect(seoActionsGlobalWorkAllowedHere(env)).toBe(
      seoGlobalWorkAllowedHere(env),
    );
    expect(seoActionsRestrictedProjects(env)).toBeNull();
  });
});

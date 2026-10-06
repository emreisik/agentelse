import { afterEach, describe, expect, it, vi } from "vitest";

import { gscRestrictedProjects, gscSyncAllowedFor } from "./flags";
import {
  SeoFlags,
  cruxApiKey,
  cwvEnabled,
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "./health-flags";

// Bu dosyanın kanıtladığı: bayraklar çağrı anında okunur; tarayıcı iki
// bayrağı da ister; izin listesi GSC bayraklarıyla birebir aynı anlamdadır;
// CWV anahtar ya da mock kipi olmadan uyur.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoFlags", () => {
  it("reads the environment at call time", () => {
    vi.stubEnv("SEO_HEALTH", "false");
    vi.stubEnv("SEO_CRAWL", "false");
    expect(SeoFlags.health()).toBe(false);
    expect(SeoFlags.crawl()).toBe(false);
    vi.stubEnv("SEO_HEALTH", "true");
    expect(SeoFlags.health()).toBe(true);
    expect(SeoFlags.crawl()).toBe(false);
    vi.stubEnv("SEO_CRAWL", "true");
    expect(SeoFlags.crawl()).toBe(true);
  });

  it("crawl needs both flags", () => {
    vi.stubEnv("SEO_HEALTH", "");
    vi.stubEnv("SEO_CRAWL", "true");
    expect(SeoFlags.crawl()).toBe(false);
    vi.stubEnv("SEO_HEALTH", "1");
    expect(SeoFlags.crawl()).toBe(false);
  });
});

// Her ortam: GSC karşılığıyla aynı sonucu vermeli.
const MATRIX: {
  name: string;
  dev?: string;
  rollout?: string;
  env: { NODE_ENV: string; DATABASE_URL: string };
}[] = [
  {
    name: "dev on live db with list",
    dev: " proj-a, proj-b ,",
    env: { NODE_ENV: "development", DATABASE_URL: LIVE },
  },
  {
    name: "dev on live db without list",
    env: { NODE_ENV: "development", DATABASE_URL: LIVE },
  },
  {
    name: "dev on local db",
    dev: "proj-a",
    env: { NODE_ENV: "development", DATABASE_URL: LOCAL },
  },
  { name: "production", env: { NODE_ENV: "production", DATABASE_URL: LIVE } },
  {
    name: "production rollout",
    rollout: "proj-a",
    env: { NODE_ENV: "production", DATABASE_URL: LIVE },
  },
  {
    name: "dev ∩ rollout",
    dev: "proj-a,proj-b",
    rollout: "proj-b,proj-c",
    env: { NODE_ENV: "development", DATABASE_URL: LIVE },
  },
  {
    name: "empty rollout",
    rollout: " , ",
    env: { NODE_ENV: "production", DATABASE_URL: LIVE },
  },
];

describe("SEO allow-lists mirror the GSC ones", () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const seo = {
        ...row.env,
        SEO_DEV_PROJECTS: row.dev,
        SEO_ROLLOUT_PROJECTS: row.rollout,
      };
      const gsc = {
        ...row.env,
        GSC_SYNC_DEV_PROJECTS: row.dev,
        GSC_ROLLOUT_PROJECTS: row.rollout,
      };
      for (const id of ["proj-a", "proj-b", "proj-c", "proj-z"]) {
        expect(seoWorkAllowedFor(id, seo)).toBe(gscSyncAllowedFor(id, gsc));
      }
      expect(seoRestrictedProjects(seo)).toEqual(gscRestrictedProjects(gsc));
    });
  }

  it("blocks global work on the shared database only", () => {
    expect(
      seoGlobalWorkAllowedHere({ NODE_ENV: "development", DATABASE_URL: LIVE }),
    ).toBe(false);
    expect(
      seoGlobalWorkAllowedHere({
        NODE_ENV: "development",
        DATABASE_URL: LOCAL,
      }),
    ).toBe(true);
    expect(
      seoGlobalWorkAllowedHere({ NODE_ENV: "production", DATABASE_URL: LIVE }),
    ).toBe(true);
  });

  it("concrete values", () => {
    const dev = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      SEO_DEV_PROJECTS: "proj-a",
    };
    expect(seoWorkAllowedFor("proj-a", dev)).toBe(true);
    expect(seoWorkAllowedFor("proj-b", dev)).toBe(false);
    expect(seoRestrictedProjects(dev)).toEqual(["proj-a"]);
    expect(seoRestrictedProjects({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("mock mode and CrUX key", () => {
  it("reads mock mode and trims the key", () => {
    expect(seoMockMode({ AGENTELSE_PROVIDER_MODE: "mock" })).toBe(true);
    expect(seoMockMode({ AGENTELSE_PROVIDER_MODE: "live" })).toBe(false);
    expect(cruxApiKey({ GOOGLE_API_KEY: "  abc  " })).toBe("abc");
    expect(cruxApiKey({ GOOGLE_API_KEY: "   " })).toBeNull();
    expect(cruxApiKey({})).toBeNull();
  });

  it("cwvEnabled needs SEO_HEALTH and the key or mock mode", () => {
    vi.stubEnv("SEO_HEALTH", "true");
    expect(cwvEnabled({ GOOGLE_API_KEY: "abc" })).toBe(true);
    expect(cwvEnabled({})).toBe(false);
    expect(cwvEnabled({ AGENTELSE_PROVIDER_MODE: "mock" })).toBe(true);
    vi.stubEnv("SEO_HEALTH", "false");
    expect(cwvEnabled({ GOOGLE_API_KEY: "abc" })).toBe(false);
    expect(cwvEnabled({ AGENTELSE_PROVIDER_MODE: "mock" })).toBe(false);
  });

  it("defaults to process.env", () => {
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(cwvEnabled()).toBe(false);
    vi.stubEnv("GOOGLE_API_KEY", "key");
    expect(cwvEnabled()).toBe(true);
  });
});

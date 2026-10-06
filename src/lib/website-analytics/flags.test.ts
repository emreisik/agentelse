import { afterEach, describe, expect, it, vi } from "vitest";

import { GaFlags, gaGlobalWorkAllowedHere, gaSyncAllowedFor } from "./flags";

// Bu dosyanın kanıtladığı: canlı veritabanını paylaşan yerel geliştirme
// süreci müşteri mülklerini senkronlamaz (yalnız listedeki projeleri) ve
// genel temizliği hiç yapmaz; canlıda ve yerel tek kullanımlık veritabanında
// her şey çalışır. GA-F2b bayrakları çağrı anında okunur, yalnız "true" açar.

describe("GA-F2b flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cases = [
    ["GA_WEEKLY", GaFlags.weekly],
    ["GA_CATALOG_CHECKS", GaFlags.catalogChecks],
    ["GA_LIVE", GaFlags.live],
    ["GA_MODULE_SECTIONS", GaFlags.moduleSections],
    ["GA_BRAND_CARD", GaFlags.brandCard],
  ] as const;

  it.each(cases)(
    "%s is read at call time and only 'true' turns it on",
    (name, flag) => {
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
    },
  );
});

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

describe("GA sync on a developer machine", () => {
  it("syncs only the listed projects against the shared database", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "proj-a, proj-b",
    };
    expect(gaSyncAllowedFor("proj-a", env)).toBe(true);
    expect(gaSyncAllowedFor("proj-c", env)).toBe(false);
    expect(gaGlobalWorkAllowedHere(env)).toBe(false);
  });

  it("runs everything in production and on a local database", () => {
    expect(
      gaSyncAllowedFor("proj-c", {
        NODE_ENV: "production",
        DATABASE_URL: LIVE,
      }),
    ).toBe(true);
    expect(
      gaSyncAllowedFor("proj-c", {
        NODE_ENV: "development",
        DATABASE_URL: LOCAL,
      }),
    ).toBe(true);
    expect(
      gaGlobalWorkAllowedHere({ NODE_ENV: "production", DATABASE_URL: LIVE }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { gaGlobalWorkAllowedHere, gaSyncAllowedFor } from "./flags";

// Bu dosyanın kanıtladığı: canlı veritabanını paylaşan yerel geliştirme
// süreci müşteri mülklerini senkronlamaz (yalnız listedeki projeleri) ve
// genel temizliği hiç yapmaz; canlıda ve yerel tek kullanımlık veritabanında
// her şey çalışır.

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

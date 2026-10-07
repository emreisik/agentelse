import { describe, expect, it } from "vitest";

import { gaAttributionEnabled, gaAttributionEnabledFor } from "./flags";

// Atıf görünümleri GA_UTM ve GA_SYNC'in ikisini de ister; yalnız "true" açar.
// Canlı veritabanını paylaşan yerel geliştirme süreci yalnız
// GA_SYNC_DEV_PROJECTS'teki projelerde çalışır.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

describe("gaAttributionEnabled", () => {
  it("needs both GA_UTM and GA_SYNC", () => {
    expect(gaAttributionEnabled({})).toBe(false);
    expect(gaAttributionEnabled({ GA_UTM: "true" })).toBe(false);
    expect(gaAttributionEnabled({ GA_SYNC: "true" })).toBe(false);
    expect(gaAttributionEnabled({ GA_UTM: "true", GA_SYNC: "true" })).toBe(
      true,
    );
  });

  it("accepts only the exact string 'true'", () => {
    expect(gaAttributionEnabled({ GA_UTM: "1", GA_SYNC: "true" })).toBe(false);
    expect(gaAttributionEnabled({ GA_UTM: "true", GA_SYNC: "TRUE" })).toBe(
      false,
    );
    expect(gaAttributionEnabled({ GA_UTM: "false", GA_SYNC: "true" })).toBe(
      false,
    );
  });
});

describe("gaAttributionEnabledFor", () => {
  const on = { GA_UTM: "true", GA_SYNC: "true" };

  it("is off when the flags are off, whatever the project", () => {
    expect(gaAttributionEnabledFor("p1", { GA_SYNC: "true" })).toBe(false);
  });

  it("allows every project in production", () => {
    expect(gaAttributionEnabledFor("p1", { ...on, NODE_ENV: "production" })).toBe(
      true,
    );
  });

  it("allows every project in a development process with a local database", () => {
    expect(
      gaAttributionEnabledFor("p1", {
        ...on,
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://postgres:pw@localhost:5432/test",
      }),
    ).toBe(true);
  });

  it("blocks an unlisted project in development with a remote database", () => {
    const env = {
      ...on,
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "p2, p3",
    };
    expect(gaAttributionEnabledFor("p1", env)).toBe(false);
    expect(gaAttributionEnabledFor("p3", env)).toBe(true);
  });
});

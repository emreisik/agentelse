import { describe, expect, it } from "vitest";

import {
  gaReportsDevProjectScope,
  gaReportsEnabled,
  gaReportsEnabledFor,
  type GaReportsEnv,
} from "./flags";

// Bu dosyanın kanıtladığı: GA_REPORTS yalnız GA_SYNC=true ile birlikte ve
// tam "true" değeriyle açar; canlı veritabanını paylaşan geliştirme süreci
// yalnız GA_SYNC_DEV_PROJECTS'teki projeler için çalışır.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

function env(extra: GaReportsEnv): GaReportsEnv {
  return {
    GA_REPORTS: "true",
    GA_SYNC: "true",
    NODE_ENV: "production",
    ...extra,
  };
}

describe("gaReportsEnabled", () => {
  it("needs both GA_REPORTS and GA_SYNC", () => {
    expect(gaReportsEnabled(env({}))).toBe(true);
    expect(gaReportsEnabled(env({ GA_SYNC: "false" }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_SYNC: undefined }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_REPORTS: "false" }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_REPORTS: undefined }))).toBe(false);
  });

  it("only the exact string 'true' enables", () => {
    expect(gaReportsEnabled(env({ GA_REPORTS: "TRUE" }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_REPORTS: "1" }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_SYNC: "1" }))).toBe(false);
    expect(gaReportsEnabled(env({ GA_SYNC: "TRUE" }))).toBe(false);
  });
});

describe("gaReportsEnabledFor", () => {
  it("allows every project in production", () => {
    expect(gaReportsEnabledFor("p1", env({}))).toBe(true);
  });

  it("is off for every project when the global switch is off", () => {
    expect(gaReportsEnabledFor("p1", env({ GA_REPORTS: "false" }))).toBe(false);
  });

  it("limits a dev process on a remote database to the allow-list", () => {
    const dev = env({
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "p1, p2",
    });
    expect(gaReportsEnabledFor("p1", dev)).toBe(true);
    expect(gaReportsEnabledFor("p2", dev)).toBe(true);
    expect(gaReportsEnabledFor("p3", dev)).toBe(false);
  });

  it("allows every project in dev on a local database", () => {
    const dev = env({ NODE_ENV: "development", DATABASE_URL: LOCAL });
    expect(gaReportsEnabledFor("p3", dev)).toBe(true);
  });
});

describe("gaReportsDevProjectScope", () => {
  it("is null in production and on a local database", () => {
    expect(gaReportsDevProjectScope(env({}))).toBeNull();
    expect(
      gaReportsDevProjectScope(
        env({ NODE_ENV: "development", DATABASE_URL: LOCAL }),
      ),
    ).toBeNull();
  });

  it("lists trimmed ids for a dev process on a remote database", () => {
    expect(
      gaReportsDevProjectScope(
        env({
          NODE_ENV: "development",
          DATABASE_URL: LIVE,
          GA_SYNC_DEV_PROJECTS: " a, ,b ,",
        }),
      ),
    ).toEqual(["a", "b"]);
  });

  it("can be empty", () => {
    expect(
      gaReportsDevProjectScope(
        env({ NODE_ENV: "development", DATABASE_URL: LIVE }),
      ),
    ).toEqual([]);
  });
});

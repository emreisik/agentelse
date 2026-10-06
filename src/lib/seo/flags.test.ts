import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GscFlags,
  gscGlobalWorkAllowedHere,
  gscRestrictedProjects,
  gscSyncAllowedFor,
} from "./flags";

// Bu dosyanın kanıtladığı: bayraklar çağrı anında okunur; canlı veritabanını
// paylaşan yerel geliştirme süreci yalnız listedeki projeleri senkronlar ve
// genel işi hiç yapmaz; GSC_ROLLOUT_PROJECTS her ortamda projeleri daraltır.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GscFlags", () => {
  it("reads the environment at call time", () => {
    vi.stubEnv("GSC_SYNC", "false");
    vi.stubEnv("GSC_SEARCH_PAGE", "");
    expect(GscFlags.sync()).toBe(false);
    expect(GscFlags.searchPage()).toBe(false);
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_SEARCH_PAGE", "true");
    expect(GscFlags.sync()).toBe(true);
    expect(GscFlags.searchPage()).toBe(true);
  });
});

describe("GSC sync on a developer machine", () => {
  it("syncs only the listed projects against the shared database", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GSC_SYNC_DEV_PROJECTS: " proj-a, proj-b ,",
    };
    expect(gscSyncAllowedFor("proj-a", env)).toBe(true);
    expect(gscSyncAllowedFor("proj-c", env)).toBe(false);
    expect(gscGlobalWorkAllowedHere(env)).toBe(false);
    expect(gscRestrictedProjects(env)).toEqual(["proj-a", "proj-b"]);
  });

  it("allows nothing on the shared database without a dev list", () => {
    const env = { NODE_ENV: "development", DATABASE_URL: LIVE };
    expect(gscSyncAllowedFor("proj-a", env)).toBe(false);
    expect(gscRestrictedProjects(env)).toEqual([]);
  });

  it("runs everything in production and on a local database", () => {
    const production = { NODE_ENV: "production", DATABASE_URL: LIVE };
    const local = { NODE_ENV: "development", DATABASE_URL: LOCAL };
    expect(gscSyncAllowedFor("proj-c", production)).toBe(true);
    expect(gscSyncAllowedFor("proj-c", local)).toBe(true);
    expect(gscGlobalWorkAllowedHere(production)).toBe(true);
    expect(gscGlobalWorkAllowedHere(local)).toBe(true);
    expect(gscRestrictedProjects(production)).toBeNull();
    expect(gscRestrictedProjects(local)).toBeNull();
  });
});

describe("GSC_ROLLOUT_PROJECTS", () => {
  it("limits production to the rollout list", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: LIVE,
      GSC_ROLLOUT_PROJECTS: "proj-a",
    };
    expect(gscSyncAllowedFor("proj-a", env)).toBe(true);
    expect(gscSyncAllowedFor("proj-b", env)).toBe(false);
    expect(gscGlobalWorkAllowedHere(env)).toBe(true);
    expect(gscRestrictedProjects(env)).toEqual(["proj-a"]);
  });

  it("intersects with the dev list on the shared database", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GSC_SYNC_DEV_PROJECTS: "proj-a,proj-b",
      GSC_ROLLOUT_PROJECTS: "proj-b,proj-c",
    };
    expect(gscSyncAllowedFor("proj-a", env)).toBe(false);
    expect(gscSyncAllowedFor("proj-b", env)).toBe(true);
    expect(gscSyncAllowedFor("proj-c", env)).toBe(false);
    expect(gscRestrictedProjects(env)).toEqual(["proj-b"]);
  });

  it("an empty value means every project", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: LIVE,
      GSC_ROLLOUT_PROJECTS: " , ",
    };
    expect(gscSyncAllowedFor("proj-z", env)).toBe(true);
    expect(gscRestrictedProjects(env)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  MAX_SITES_PER_PROJECT,
  gscAgencyActiveFor,
  gscAgencyOn,
  gscBigQueryActiveFor,
  gscBigQueryOn,
} from "./flags";

describe("gscAgencyOn", () => {
  it("opens only on the exact value 'true' together with GSC_SYNC", () => {
    expect(gscAgencyOn({ GSC_AGENCY: "true", GSC_SYNC: "true" })).toBe(true);
    for (const value of ["TRUE", "1", "yes", " true", ""]) {
      expect(gscAgencyOn({ GSC_AGENCY: value, GSC_SYNC: "true" })).toBe(false);
    }
  });

  it("is off when GSC_SYNC is missing or not exactly 'true'", () => {
    expect(gscAgencyOn({ GSC_AGENCY: "true" })).toBe(false);
    expect(gscAgencyOn({ GSC_AGENCY: "true", GSC_SYNC: "1" })).toBe(false);
  });
});

describe("gscBigQueryOn", () => {
  it("needs the agency flag as well", () => {
    expect(gscBigQueryOn({ GSC_BIGQUERY: "true", GSC_SYNC: "true" })).toBe(false);
    expect(
      gscBigQueryOn({ GSC_BIGQUERY: "true", GSC_AGENCY: "true", GSC_SYNC: "true" }),
    ).toBe(true);
    expect(
      gscBigQueryOn({ GSC_BIGQUERY: "yes", GSC_AGENCY: "true", GSC_SYNC: "true" }),
    ).toBe(false);
  });
});

describe("dev guard", () => {
  const dev = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://u:p@ep-live.neon.tech/db",
    GSC_SYNC: "true",
    GSC_AGENCY: "true",
    GSC_BIGQUERY: "true",
    GSC_SYNC_DEV_PROJECTS: "proj-a, proj-b",
  };

  it("lets a dev process on a remote database touch only the allow-listed projects", () => {
    expect(gscAgencyActiveFor("proj-a", dev)).toBe(true);
    expect(gscAgencyActiveFor("proj-b", dev)).toBe(true);
    expect(gscAgencyActiveFor("proj-c", dev)).toBe(false);
    expect(gscBigQueryActiveFor("proj-a", dev)).toBe(true);
    expect(gscBigQueryActiveFor("proj-c", dev)).toBe(false);
  });

  it("honours the rollout list in any environment", () => {
    const env = { ...dev, NODE_ENV: "production", GSC_ROLLOUT_PROJECTS: "proj-z" };
    expect(gscAgencyActiveFor("proj-z", env)).toBe(true);
    expect(gscAgencyActiveFor("proj-a", env)).toBe(false);
  });

  it("is off for every project when the flag is off", () => {
    expect(gscAgencyActiveFor("proj-a", { ...dev, GSC_AGENCY: undefined })).toBe(false);
  });
});

describe("limits", () => {
  it("counts the primary site in the per-project maximum", () => {
    expect(MAX_SITES_PER_PROJECT).toBe(5);
  });
});

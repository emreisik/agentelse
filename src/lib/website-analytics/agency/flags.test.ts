import { describe, expect, it } from "vitest";

import {
  gaAgencyDevProjectScope,
  gaAgencyEnabled,
  gaAgencyEnabledFor,
  gaAgencyMockMode,
  gaBigQueryEnabled,
  gaBigQueryEnabledFor,
  gaFunnelEnabled,
  gaFunnelEnabledFor,
  gaFunnelLiveAllowed,
  googleRiscEnabled,
} from "./flags";

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";
const ON = { GA_AGENCY: "true", GA_SYNC: "true" };

describe("GA-F8 flags", () => {
  it("gaAgencyEnabled needs the literal 'true' for both GA_AGENCY and GA_SYNC", () => {
    expect(gaAgencyEnabled({})).toBe(false);
    expect(gaAgencyEnabled({ GA_AGENCY: "true" })).toBe(false);
    expect(gaAgencyEnabled({ GA_SYNC: "true" })).toBe(false);
    expect(gaAgencyEnabled({ GA_AGENCY: "1", GA_SYNC: "true" })).toBe(false);
    expect(gaAgencyEnabled({ GA_AGENCY: "TRUE", GA_SYNC: "true" })).toBe(false);
    expect(gaAgencyEnabled(ON)).toBe(true);
  });

  it("BigQuery and funnel need GA_AGENCY plus their own flag", () => {
    expect(gaBigQueryEnabled({ GA_BIGQUERY: "true" })).toBe(false);
    expect(gaBigQueryEnabled(ON)).toBe(false);
    expect(gaBigQueryEnabled({ ...ON, GA_BIGQUERY: "yes" })).toBe(false);
    expect(gaBigQueryEnabled({ ...ON, GA_BIGQUERY: "true" })).toBe(true);
    expect(gaFunnelEnabled({ GA_FUNNEL: "true" })).toBe(false);
    expect(gaFunnelEnabled(ON)).toBe(false);
    expect(gaFunnelEnabled({ ...ON, GA_FUNNEL: "true" })).toBe(true);
  });

  it("the funnel live switch is independent of GA_FUNNEL", () => {
    expect(gaFunnelLiveAllowed({})).toBe(false);
    expect(gaFunnelLiveAllowed({ GA_FUNNEL_ALPHA: "1" })).toBe(false);
    expect(gaFunnelLiveAllowed({ GA_FUNNEL_ALPHA: "true" })).toBe(true);
    expect(gaFunnelLiveAllowed({ ...ON, GA_FUNNEL: "true" })).toBe(false);
  });

  it("RISC does not depend on GA_AGENCY", () => {
    expect(googleRiscEnabled({})).toBe(false);
    expect(googleRiscEnabled({ GOOGLE_RISC: "1" })).toBe(false);
    expect(googleRiscEnabled({ GOOGLE_RISC: "true" })).toBe(true);
    expect(googleRiscEnabled({ GOOGLE_RISC: "true", GA_AGENCY: "false" })).toBe(
      true,
    );
  });

  it("mock mode is only the literal 'mock'", () => {
    expect(gaAgencyMockMode({})).toBe(false);
    expect(gaAgencyMockMode({ AGENTELSE_PROVIDER_MODE: "live" })).toBe(false);
    expect(gaAgencyMockMode({ AGENTELSE_PROVIDER_MODE: "mock" })).toBe(true);
  });

  it("per-project variants honour the dev project allow-list", () => {
    const shared = {
      ...ON,
      GA_BIGQUERY: "true",
      GA_FUNNEL: "true",
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "proj-a, proj-b",
    };
    for (const check of [
      gaAgencyEnabledFor,
      gaBigQueryEnabledFor,
      gaFunnelEnabledFor,
    ]) {
      expect(check("proj-a", shared)).toBe(true);
      expect(check("proj-b", shared)).toBe(true);
      expect(check("proj-c", shared)).toBe(false);
      expect(check("proj-c", { ...shared, DATABASE_URL: LOCAL })).toBe(true);
      expect(check("proj-c", { ...shared, NODE_ENV: "production" })).toBe(true);
      expect(check("proj-a", { ...shared, GA_SYNC: "false" })).toBe(false);
    }
  });

  it("the dev project scope is null where global work is allowed", () => {
    expect(gaAgencyDevProjectScope({ NODE_ENV: "production" })).toBeNull();
    expect(
      gaAgencyDevProjectScope({ NODE_ENV: "development", DATABASE_URL: LOCAL }),
    ).toBeNull();
    expect(
      gaAgencyDevProjectScope({
        NODE_ENV: "development",
        DATABASE_URL: LIVE,
        GA_SYNC_DEV_PROJECTS: " a , b,, ",
      }),
    ).toEqual(["a", "b"]);
    expect(
      gaAgencyDevProjectScope({ NODE_ENV: "development", DATABASE_URL: LIVE }),
    ).toEqual([]);
  });
});

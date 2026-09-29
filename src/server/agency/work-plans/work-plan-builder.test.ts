import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { buildCampaignNodes } =
  await import("@/server/agency/work-plans/work-plan-builder");

const ALL_DEPARTMENTS = [
  "CREATIVE",
  "SOCIAL_MEDIA",
  "PERFORMANCE_MARKETING",
  "SEO",
  "WEB_PRODUCT",
  "PR_MEDIA",
  "CRM_LIFECYCLE",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildCampaignNodes (agency focus mode)", () => {
  it("keeps only social/ads departments when AGENCY_FOCUS=social_ads", () => {
    vi.stubEnv("AGENCY_FOCUS", "social_ads");
    const nodes = buildCampaignNodes("Launch", [...ALL_DEPARTMENTS]);
    const capabilities = nodes.map((node) => node.capability);

    expect(capabilities).toEqual([
      "CREATE_CAMPAIGN_BRIEF",
      "CREATE_SOCIAL_CREATIVE",
      "CREATE_CONTENT_PLAN",
      "META_ADS_ANALYSIS",
      "REPORTING",
    ]);
  });

  it("keeps every department by default", () => {
    const capabilities = buildCampaignNodes("Launch", [...ALL_DEPARTMENTS]).map(
      (node) => node.capability,
    );

    expect(capabilities).toContain("SEO_ANALYSIS");
    expect(capabilities).toContain("WEBSITE_UPDATE");
    expect(capabilities).toContain("PR_OUTREACH");
    expect(capabilities).toContain("EMAIL_DRAFT");
  });
});

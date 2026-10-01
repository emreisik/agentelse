import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  list: vi.fn(),
  insights: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/security/crypto", () => ({ decryptSecret: () => "tok" }));
vi.mock("@/server/integrations/meta-client", () => ({
  META_PROVIDER: { ads: "meta-ads" },
  listMetaCampaigns: m.list,
  fetchMetaLevelInsights: m.insights,
  listMetaAdSets: vi.fn(),
  listMetaAds: vi.fn(),
}));

import { MetaAdsQuery } from "./meta-ads-query";

const conn = {
  status: "READY" as const,
  accessToken: "tok",
  adAccountId: "act_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue([
    { campaignId: "k1", name: "Leads", objective: "OUTCOME_LEADS" },
    { campaignId: "k2", name: "Traffic", objective: "OUTCOME_TRAFFIC" },
  ]);
  m.insights.mockResolvedValue(new Map());
});

describe("MetaAdsQuery.campaigns lead preference (Works ads refresh)", () => {
  it("default: the original two calls with no lead option", async () => {
    await MetaAdsQuery.campaigns(conn, "last_7d");
    expect(m.insights).toHaveBeenCalledWith({
      adAccountId: "act_1",
      accessToken: "tok",
      level: "campaign",
      datePreset: "last_7d",
    });
  });

  it("with the option: leads campaigns are asked to report their leads", async () => {
    await MetaAdsQuery.campaigns(conn, "last_7d", {
      preferLeadForLeadsCampaigns: true,
    });
    const arg = m.insights.mock.calls[0]![0] as {
      preferLeadFor?: ReadonlySet<string>;
    };
    expect([...(arg.preferLeadFor ?? [])]).toEqual(["k1"]);
  });
});

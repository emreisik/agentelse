import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn<(arg: { data: { metadata: Record<string, unknown> } }) => Promise<unknown>>(),
  executeRaw: vi.fn<(strings: string[], json: string, id: string) => Promise<number>>(),
  findMany: vi.fn(),
  projectFind: vi.fn(),
  listCampaigns: vi.fn(),
  fetchInsights: vi.fn<(arg: { preferLeadFor?: ReadonlySet<string> }) => Promise<unknown>>(),
  listAdSets: vi.fn(),
  works: vi.fn(),
  digest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: m.findMany, update: m.update },
    project: { findUnique: m.projectFind },
    $executeRaw: m.executeRaw,
  },
}));
vi.mock("@/server/security/crypto", () => ({ decryptSecret: () => "tok" }));
vi.mock("@/server/agency/signals/signal-universe", () => ({
  SignalUniverse: { ingestRaw: vi.fn() },
}));
vi.mock("./performance-optimizer", () => ({
  PerformanceOptimizer: {
    proposeCampaignAction: vi.fn(),
    proposeAdSetAction: vi.fn(),
    proposeCreativeRefresh: vi.fn(),
  },
}));
vi.mock("@/server/integrations/meta-client", () => ({
  META_PROVIDER: { ads: "meta-ads" },
  listMetaCampaigns: m.listCampaigns,
  fetchMetaLevelInsights: m.fetchInsights,
  listMetaAdSets: m.listAdSets,
}));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: m.works }));
vi.mock("@/lib/works/ads-insight", async (orig) => {
  const actual = await orig<typeof import("@/lib/works/ads-insight")>();
  return {
    ...actual,
    buildAdsDigest: (...a: Parameters<typeof actual.buildAdsDigest>) =>
      m.digest(...a) ?? actual.buildAdsDigest(...a),
  };
});

import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { MetaPerformanceScanner } from "./meta-performance-scanner";

const metadata = {
  selectedAdAccountId: "act_1",
  adAccounts: [{ adAccountId: "act_1", currency: "TRY" }],
  previousScanSnapshot: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  m.digest.mockReturnValue(undefined);
  m.findMany.mockResolvedValue([
    {
      id: "c1",
      workspaceId: "w",
      projectId: "p",
      brandId: "b",
      encryptedSecret: "x",
      metadata,
    },
  ]);
  m.projectFind.mockResolvedValue({ status: "ACTIVE" });
  m.listCampaigns.mockResolvedValue([
    {
      campaignId: "k1",
      name: "Leads",
      objective: "OUTCOME_LEADS",
      effectiveStatus: "ACTIVE",
      dailyBudgetCents: 5000,
    },
    {
      campaignId: "k2",
      name: "Traffic",
      objective: "OUTCOME_TRAFFIC",
      effectiveStatus: "ACTIVE",
      dailyBudgetCents: 5000,
    },
  ]);
  m.fetchInsights.mockResolvedValue(
    new Map([
      ["k1", { spend: 100, ctr: 1, resultCount: 5, costPerResult: 20 }],
      ["k2", { spend: 50, ctr: 1, resultCount: 5, costPerResult: 10 }],
    ]),
  );
  m.update.mockResolvedValue({});
  m.executeRaw.mockResolvedValue(1);
});

describe("meta performance scanner digest (ads-digest, W107)", () => {
  it("flag on: original update unchanged, then exactly one jsonb_set write", async () => {
    m.works.mockReturnValue(true);
    await MetaPerformanceScanner.runDueScans();
    expect(m.update).toHaveBeenCalledTimes(1);
    const data = m.update.mock.calls[0]![0].data.metadata;
    expect(Object.keys(data).sort()).toEqual(
      [
        "adAccounts",
        "adsPerformanceScanFailureCount",
        "lastAdsPerformanceScanAt",
        "previousScanSnapshot",
        "selectedAdAccountId",
      ].sort(),
    );
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, json, id] = m.executeRaw.mock.calls[0]!;
    expect(strings.join("?")).toContain("jsonb_set");
    expect(strings.join("?")).toContain("'{adsDigest}'");
    expect(strings.join("?")).toContain("status = 'ACTIVE'");
    expect(id).toBe("c1");
    const digest = JSON.parse(json);
    expect(digest.currency).toBe("TRY");
    // Bound to the account the numbers were read from.
    expect(digest.adAccountId).toBe("act_1");
    expect(digest.campaigns.map((c: { id: string }) => c.id)).toEqual([
      "k1",
      "k2",
    ]);
    // The update ran before the digest write.
    expect(m.update.mock.invocationCallOrder[0]!).toBeLessThan(
      m.executeRaw.mock.invocationCallOrder[0]!,
    );
    // Leads campaigns are asked to prefer the lead action.
    const preferred = m.fetchInsights.mock.calls[0]![0].preferLeadFor;
    expect([...(preferred ?? [])]).toEqual(["k1"]);
  });

  it("flag off: no extra statement and no preferLead option", async () => {
    m.works.mockReturnValue(false);
    await MetaPerformanceScanner.runDueScans();
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(m.update.mock.calls[0]![0].data.metadata)).not.toContain(
      "adsDigest",
    );
    expect(m.fetchInsights.mock.calls[0]![0].preferLeadFor).toBeUndefined();
  });

  it("a digest build error does not fail the scan", async () => {
    m.works.mockReturnValue(true);
    m.digest.mockImplementation(() => {
      throw new Error("boom");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(MetaPerformanceScanner.runDueScans()).resolves.toBe(1);
    expect(m.executeRaw).not.toHaveBeenCalled();
    // Only the success update: no failure-path update.
    expect(m.update).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("an $executeRaw error does not fail the scan", async () => {
    m.works.mockReturnValue(true);
    m.executeRaw.mockRejectedValue(new Error("db"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(MetaPerformanceScanner.runDueScans()).resolves.toBe(1);
    expect(m.update).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  describe("result label baseline (Leads vs Link Clicks)", () => {
    const leadsInsight = new Map([
      [
        "k1",
        {
          spend: 100,
          ctr: 1,
          resultCount: 5,
          resultLabel: "Leads",
          costPerResult: 20,
        },
      ],
    ]);
    const oldBaseline = {
      "meta-campaign:k1": { spend: 100, ctr: 1, costPerResult: 1 },
    };
    const trendIngests = () =>
      vi
        .mocked(SignalUniverse.ingestRaw)
        .mock.calls.filter((c) =>
          String((c[0] as { externalRef?: string }).externalRef).endsWith(
            "CPA_REGRESSION",
          ),
        );

    beforeEach(() => {
      m.fetchInsights.mockResolvedValue(leadsInsight);
      m.findMany.mockResolvedValue([
        {
          id: "c1",
          workspaceId: "w",
          projectId: "p",
          brandId: "b",
          encryptedSecret: "x",
          metadata: { ...metadata, previousScanSnapshot: oldBaseline },
        },
      ]);
    });

    it("flag on: a baseline without the same result name gives no trend finding and no vs-last-check, and the snapshot names its result", async () => {
      m.works.mockReturnValue(true);
      await MetaPerformanceScanner.runDueScans();
      expect(trendIngests()).toHaveLength(0);
      const snapshot = m.update.mock.calls[0]![0].data.metadata
        .previousScanSnapshot as Record<string, { resultLabel?: string }>;
      expect(snapshot["meta-campaign:k1"]?.resultLabel).toBe("Leads");
      const digest = JSON.parse(m.executeRaw.mock.calls[0]![1]);
      expect(digest.campaigns[0].costChangePct).toBeUndefined();
      expect(digest.campaigns[0].prevCostPerResult).toBeUndefined();
    });

    it("flag on: a baseline with the same result name still compares", async () => {
      m.works.mockReturnValue(true);
      m.findMany.mockResolvedValue([
        {
          id: "c1",
          workspaceId: "w",
          projectId: "p",
          brandId: "b",
          encryptedSecret: "x",
          metadata: {
            ...metadata,
            previousScanSnapshot: {
              "meta-campaign:k1": {
                spend: 100,
                ctr: 1,
                costPerResult: 10,
                resultLabel: "Leads",
              },
            },
          },
        },
      ]);
      await MetaPerformanceScanner.runDueScans();
      expect(trendIngests()).toHaveLength(1);
      const digest = JSON.parse(m.executeRaw.mock.calls[0]![1]);
      expect(digest.campaigns[0].costChangePct).toBe(100);
    });

    it("flag off: the old comparison and the stored snapshot are unchanged", async () => {
      m.works.mockReturnValue(false);
      await MetaPerformanceScanner.runDueScans();
      expect(trendIngests()).toHaveLength(1);
      const snapshot = m.update.mock.calls[0]![0].data.metadata
        .previousScanSnapshot as Record<string, Record<string, unknown>>;
      expect(snapshot["meta-campaign:k1"]).not.toHaveProperty("resultLabel");
    });
  });
});

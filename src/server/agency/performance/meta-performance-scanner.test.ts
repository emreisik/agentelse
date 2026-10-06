import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn<(arg: { data: { metadata: Record<string, unknown> } }) => Promise<unknown>>(),
  executeRaw: vi.fn<(strings: string[], ...values: unknown[]) => Promise<number>>(),
  findMany: vi.fn(),
  projectFind: vi.fn(),
  listCampaigns: vi.fn(),
  fetchInsights: vi.fn<
    (arg: {
      preferLeadFor?: ReadonlySet<string>;
      level?: string;
      resultSourceFor?: ReadonlyMap<string, unknown>;
    }) => Promise<unknown>
  >(),
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
vi.mock("@/server/integrations/meta-credential-health", () => ({
  markMetaCredentialExpiredOn: vi.fn().mockResolvedValue(false),
}));
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

// F0b: metadata is written key by key (jsonb_set), never as a whole object.
const keyWrites = () =>
  m.executeRaw.mock.calls
    .filter(([strings]) => strings.join("?").includes("::text[]"))
    .map(([, path, json, id]) => ({
      key: (path as string[])[0],
      value: JSON.parse(json as string) as unknown,
      id,
    }));
const keyValue = (key: string) => keyWrites().find((w) => w.key === key)?.value;
const digestWrites = () =>
  m.executeRaw.mock.calls.filter(([strings]) =>
    strings.join("?").includes("'{adsDigest}'"),
  );

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
  it("flag on: the scan keys are written one by one, then exactly one digest write", async () => {
    m.works.mockReturnValue(true);
    await MetaPerformanceScanner.runDueScans();
    // Never a whole-object write (it would put back a changed account choice).
    expect(m.update).not.toHaveBeenCalled();
    expect(keyWrites().map((w) => w.key).sort()).toEqual(
      [
        "adsPerformanceScanFailureCount",
        "lastAdsPerformanceScanAt",
        "previousScanSnapshot",
      ].sort(),
    );
    expect(keyWrites().every((w) => w.id === "c1")).toBe(true);
    expect(digestWrites()).toHaveLength(1);
    const [strings, json, id] = digestWrites()[0]!;
    expect(strings.join("?")).toContain("jsonb_set");
    expect(strings.join("?")).toContain("'{adsDigest}'");
    expect(strings.join("?")).toContain("status = 'ACTIVE'");
    expect(id).toBe("c1");
    const digest = JSON.parse(json as string);
    expect(digest.currency).toBe("TRY");
    // Bound to the account the numbers were read from.
    expect(digest.adAccountId).toBe("act_1");
    expect(digest.campaigns.map((c: { id: string }) => c.id)).toEqual([
      "k1",
      "k2",
    ]);
    // The scan keys were written before the digest.
    const digestCall = m.executeRaw.mock.calls.indexOf(digestWrites()[0]!);
    expect(digestCall).toBe(m.executeRaw.mock.calls.length - 1);
    // Leads campaigns are asked to prefer the lead action.
    const preferred = m.fetchInsights.mock.calls[0]![0].preferLeadFor;
    expect([...(preferred ?? [])]).toEqual(["k1"]);
  });

  it("flag off: no extra statement and no preferLead option", async () => {
    m.works.mockReturnValue(false);
    await MetaPerformanceScanner.runDueScans();
    expect(digestWrites()).toHaveLength(0);
    expect(keyWrites().map((w) => w.key)).not.toContain("adsDigest");
    expect(m.fetchInsights.mock.calls[0]![0].preferLeadFor).toBeUndefined();
  });

  it("a digest build error does not fail the scan", async () => {
    m.works.mockReturnValue(true);
    m.digest.mockImplementation(() => {
      throw new Error("boom");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(MetaPerformanceScanner.runDueScans()).resolves.toBe(1);
    expect(digestWrites()).toHaveLength(0);
    // Only the success write: no failure-path backoff.
    expect(keyValue("adsPerformanceScanFailureCount")).toBe(0);
    err.mockRestore();
  });

  it("an $executeRaw error does not fail the scan", async () => {
    m.works.mockReturnValue(true);
    m.executeRaw.mockImplementation(async (strings: string[]) => {
      if (strings.join("?").includes("'{adsDigest}'")) throw new Error("db");
      return 1;
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(MetaPerformanceScanner.runDueScans()).resolves.toBe(1);
    expect(keyValue("adsPerformanceScanFailureCount")).toBe(0);
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
      const snapshot = keyValue("previousScanSnapshot") as Record<
        string,
        { resultLabel?: string }
      >;
      expect(snapshot["meta-campaign:k1"]?.resultLabel).toBe("Leads");
      const digest = JSON.parse(digestWrites()[0]![1] as string);
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
      const digest = JSON.parse(digestWrites()[0]![1] as string);
      expect(digest.campaigns[0].costChangePct).toBe(100);
    });

    it("flag off: the old comparison and the stored snapshot are unchanged", async () => {
      m.works.mockReturnValue(false);
      await MetaPerformanceScanner.runDueScans();
      expect(trendIngests()).toHaveLength(1);
      const snapshot = keyValue("previousScanSnapshot") as Record<
        string,
        Record<string, unknown>
      >;
      expect(snapshot["meta-campaign:k1"]).not.toHaveProperty("resultLabel");
    });
  });
});

describe("ABO campaigns are judged on their ad sets (F0b)", () => {
  it("drills into a campaign without a campaign budget and proposes on the ad set", async () => {
    m.works.mockReturnValue(false);
    m.listCampaigns.mockResolvedValue([
      {
        campaignId: "abo",
        name: "Built by Agentelse",
        objective: "OUTCOME_TRAFFIC",
        effectiveStatus: "ACTIVE",
      },
    ]);
    m.fetchInsights.mockImplementation(async (arg: { level?: string }) =>
      arg.level === "campaign"
        ? new Map([["abo", { spend: 300, ctr: 1, resultCount: 0 }]])
        : new Map([["as1", { spend: 300, ctr: 1, resultCount: 0 }]]),
    );
    m.listAdSets.mockResolvedValue([
      {
        adSetId: "as1",
        name: "TR 18-65",
        effectiveStatus: "ACTIVE",
        dailyBudgetCents: 5000,
        optimizationGoal: "LINK_CLICKS",
      },
    ]);
    const { PerformanceOptimizer } = await import("./performance-optimizer");

    await MetaPerformanceScanner.runDueScans();

    const adSetCall = m.fetchInsights.mock.calls.find(
      ([arg]) => (arg as { level?: string }).level === "adset",
    )?.[0] as { resultSourceFor?: ReadonlyMap<string, unknown> } | undefined;
    // The ad set's result is read from its optimization goal.
    expect(adSetCall?.resultSourceFor?.get("as1")).toEqual({
      kind: "action",
      actionType: "link_click",
    });
    expect(PerformanceOptimizer.proposeAdSetAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adSetId: "as1",
        account: { adAccountId: "act_1", currency: "TRY" },
      }),
    );
    expect(PerformanceOptimizer.proposeCampaignAction).not.toHaveBeenCalled();
  });
});

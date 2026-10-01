import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialFindUnique: vi.fn(),
  approvalFindMany: vi.fn(),
  taskFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    approval: { findMany: mocks.approvalFindMany },
    task: { findMany: mocks.taskFindMany },
  },
}));
vi.mock("@/server/integrations/meta-client", () => ({
  META_PROVIDER: { ads: "meta_ads" },
}));

import {
  digestForAccount,
  loadAdsPulse,
  readAdsDigest,
} from "@/server/works/ads-pulse";

const DIGEST = {
  at: "2026-10-01T10:00:00.000Z",
  currency: "TRY",
  adAccountId: "act_1",
  campaigns: [
    {
      id: "c1",
      name: "Leads",
      dailyBudgetCents: 40000,
      spend: 120.5,
      resultLabel: "Leads",
      resultCount: 5,
      costPerResult: 38.2,
      prevCostPerResult: 32.4,
      costChangePct: 17.9,
      ctr: 1.4,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credentialFindUnique.mockResolvedValue(null);
  mocks.approvalFindMany.mockResolvedValue([]);
  mocks.taskFindMany.mockResolvedValue([]);
});

describe("loadAdsPulse", () => {
  it("reads the credential ONCE, without the secret, by project and provider", async () => {
    await loadAdsPulse("p1");
    expect(mocks.credentialFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.credentialFindUnique).toHaveBeenCalledWith({
      where: { projectId_provider: { projectId: "p1", provider: "meta_ads" } },
      select: { status: true, metadata: true },
    });
  });

  it("not connected: no credential, or a credential that is not ACTIVE", async () => {
    expect(await loadAdsPulse("p1")).toEqual({
      connected: false,
      hasAccount: false,
      proposals: [],
    });
    mocks.credentialFindUnique.mockResolvedValue({
      status: "REVOKED",
      metadata: { selectedAdAccountId: "act_1", adsDigest: DIGEST },
    });
    expect(await loadAdsPulse("p1")).toMatchObject({
      connected: false,
      hasAccount: false,
    });
  });

  it("connected without an ad account", async () => {
    mocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {},
    });
    expect(await loadAdsPulse("p1")).toMatchObject({
      connected: true,
      hasAccount: false,
      digest: null,
    });
  });

  it("connected, scanned: digest, last scan and failure count come through", async () => {
    mocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedAdAccountId: "act_1",
        adsDigest: DIGEST,
        lastAdsPerformanceScanAt: "2026-10-01T10:00:00.000Z",
        adsPerformanceScanFailureCount: 2,
      },
    });
    const pulse = await loadAdsPulse("p1");
    expect(pulse).toMatchObject({
      connected: true,
      hasAccount: true,
      lastScanAt: "2026-10-01T10:00:00.000Z",
      failureCount: 2,
    });
    expect(pulse.digest).toEqual(DIGEST);
  });

  it("a digest of another ad account than the selected one is treated as absent", async () => {
    mocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        // The owner switched from act_1 (digest below) to act_2.
        selectedAdAccountId: "act_2",
        adsDigest: DIGEST,
        lastAdsPerformanceScanAt: "2026-10-01T10:00:00.000Z",
      },
    });
    const pulse = await loadAdsPulse("p1");
    expect(pulse).toMatchObject({ connected: true, hasAccount: true });
    expect(pulse.digest).toBeNull();
  });

  it("a digest with no account stamp cannot be proven to match and is absent", async () => {
    const { adAccountId: _omit, ...legacy } = DIGEST;
    void _omit;
    mocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { selectedAdAccountId: "act_1", adsDigest: legacy },
    });
    expect((await loadAdsPulse("p1")).digest).toBeNull();
  });

  it("digestForAccount: matches only the stamped account", () => {
    const digest = readAdsDigest(DIGEST);
    expect(digestForAccount(digest, "act_1")).toEqual(digest);
    expect(digestForAccount(digest, "act_2")).toBeNull();
    expect(digestForAccount(null, "act_1")).toBeNull();
  });

  it("reads proposals from the STRUCTURED task payload of pending Task approvals", async () => {
    mocks.approvalFindMany.mockResolvedValue([
      { id: "a1", entityId: "t1" },
      { id: "a2", entityId: "t-other" },
    ]);
    mocks.taskFindMany.mockResolvedValue([
      {
        id: "t1",
        capability: "META_CAMPAIGN_UPDATE",
        payload: {
          campaignId: "c1",
          campaignName: "Leads",
          currentDailyBudgetCents: 40000,
          proposedDailyBudgetCents: 50000,
          reason: "CPL is low",
          details: "Raise to 500 TL (do not parse me)",
        },
      },
    ]);
    const pulse = await loadAdsPulse("p1");
    expect(pulse.proposals).toEqual([
      {
        taskId: "t1",
        approvalId: "a1",
        capability: "META_CAMPAIGN_UPDATE",
        campaignId: "c1",
        campaignName: "Leads",
        currentDailyBudgetCents: 40000,
        proposedDailyBudgetCents: 50000,
        reason: "CPL is low",
      },
    ]);
    expect(mocks.approvalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", status: "PENDING", entityType: "Task" },
      }),
    );
    expect(mocks.taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["t1", "t-other"] },
          projectId: "p1",
          capability: { in: ["META_CAMPAIGN_UPDATE", "META_ADSET_UPDATE"] },
        },
      }),
    );
  });

  it("ignores bad payload values instead of passing them on", async () => {
    mocks.taskFindMany.mockResolvedValue([
      {
        id: "t1",
        capability: "META_ADSET_UPDATE",
        payload: {
          currentDailyBudgetCents: "400",
          proposedDailyBudgetCents: Number.NaN,
          proposedStatus: "PAUSED",
        },
      },
      { id: "t2", capability: "IMAGE_CREATE", payload: null },
    ]);
    mocks.approvalFindMany.mockResolvedValue([
      { id: "a1", entityId: "t1" },
      { id: "a2", entityId: "t2" },
    ]);
    const { proposals } = await loadAdsPulse("p1");
    expect(proposals).toEqual([
      {
        taskId: "t1",
        approvalId: "a1",
        capability: "META_ADSET_UPDATE",
        proposedStatus: "PAUSED",
      },
    ]);
  });

  it("never throws: a failed read degrades to the emptiest honest state", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.credentialFindUnique.mockRejectedValue(new Error("db down"));
    mocks.approvalFindMany.mockRejectedValue(new Error("db down"));
    await expect(loadAdsPulse("p1")).resolves.toEqual({
      connected: false,
      hasAccount: false,
      proposals: [],
    });
    err.mockRestore();
  });

  it("one failing read does not zero the other", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { selectedAdAccountId: "act_1" },
    });
    mocks.approvalFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadAdsPulse("p1")).toMatchObject({
      connected: true,
      hasAccount: true,
      proposals: [],
    });
    err.mockRestore();
  });

  it("makes no network call: the module imports no Graph or LLM client", () => {
    const source = readFileSync("src/server/works/ads-pulse.ts", "utf8");
    expect(source).not.toMatch(/meta-ads-query|decryptSecret|crypto|fetch\(|openai/);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toContain("@/server/integrations/meta-client");
    expect(imports).not.toContain("@/server/integrations/meta-ads-query");
  });
});

describe("readAdsDigest", () => {
  it("returns null for anything that is not a digest", () => {
    for (const bad of [undefined, null, "x", 5, [], {}, { at: "x" }]) {
      expect(readAdsDigest(bad)).toBeNull();
    }
  });

  it("drops malformed campaign rows and caps at five", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      dailyBudgetCents: 1000,
      spend: 1,
    }));
    const digest = readAdsDigest({
      at: "2026-10-01T10:00:00.000Z",
      currency: "TRY",
      campaigns: [{ id: "bad" }, null, ...rows],
    });
    expect(digest?.campaigns).toHaveLength(5);
    expect(digest?.campaigns[0]?.id).toBe("c0");
  });
});

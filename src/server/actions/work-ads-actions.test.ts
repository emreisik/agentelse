import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
  workFindFirst: vi.fn(),
  credentialFindUnique: vi.fn(),
  credentialUpdate: vi.fn(),
  executeRaw: vi.fn(),
  commandCreate: vi.fn(),
  resolveConnection: vi.fn(),
  campaigns: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    work: { findFirst: mocks.workFindFirst },
    integrationCredential: {
      findUnique: mocks.credentialFindUnique,
      update: mocks.credentialUpdate,
    },
    command: { create: mocks.commandCreate },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/integrations/meta-client", () => {
  class MetaApiError extends Error {
    readonly metaErrorCode?: number;
    constructor(message: string, metaErrorCode?: number) {
      super(message);
      this.metaErrorCode = metaErrorCode;
    }
  }
  return { META_PROVIDER: { ads: "meta_ads" }, MetaApiError };
});
vi.mock("@/server/integrations/meta-ads-query", () => ({
  MetaAdsQuery: {
    resolveConnection: mocks.resolveConnection,
    campaigns: mocks.campaigns,
  },
}));

import { MetaApiError } from "@/server/integrations/meta-client";
import { refreshAdsPulseAction } from "@/server/actions/work-ads-actions";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function credential(adsDigest?: unknown) {
  return {
    id: "cred1",
    status: "ACTIVE",
    metadata: {
      selectedAdAccountId: "act_1",
      adAccounts: [
        { adAccountId: "act_1", adAccountName: "Main", currency: "TRY" },
      ],
      ...(adsDigest ? { adsDigest } : {}),
    },
  };
}

function digestAt(date: Date) {
  return {
    at: date.toISOString(),
    currency: "TRY",
    adAccountId: "act_1",
    campaigns: [
      { id: "c1", name: "Leads", dailyBudgetCents: 40000, spend: 100, costPerResult: 30 },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isRateLimited.mockReturnValue(false);
  mocks.workFindFirst.mockResolvedValue({ id: "w1" });
  mocks.credentialFindUnique.mockResolvedValue(
    credential(digestAt(new Date(NOW.getTime() - 60 * 60_000))),
  );
  mocks.resolveConnection.mockResolvedValue({
    status: "READY",
    accessToken: "tok",
    adAccountId: "act_1",
  });
  mocks.campaigns.mockResolvedValue([
    {
      campaignId: "c1",
      name: "Leads",
      objective: "OUTCOME_LEADS",
      status: "ACTIVE",
      effectiveStatus: "ACTIVE",
      dailyBudgetCents: 40000,
      insights: {
        spend: 200,
        resultLabel: "Leads",
        resultCount: 5,
        costPerResult: 36,
        ctr: 1.2,
      },
    },
    {
      campaignId: "c2",
      name: "Paused",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      dailyBudgetCents: 1000,
    },
  ]);
  mocks.executeRaw.mockResolvedValue(1);
});

describe("refreshAdsPulseAction guard W109 (ads-action)", () => {
  it("re-checks the flag before anything is read", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.workFindFirst).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("checks project access with the signed-in user and rate limits 'ads-pulse' at 6 per 10 minutes", async () => {
    await refreshAdsPulseAction("p1", "w1");
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "ads-pulse:u1",
      6,
      10 * 60_000,
    );
    mocks.isRateLimited.mockReturnValue(true);
    mocks.executeRaw.mockClear();
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("rejects a Work of another project (looked up with the project id)", async () => {
    mocks.workFindFirst.mockResolvedValue(null);
    const r = await refreshAdsPulseAction("p1", "w-foreign");
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.workFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w-foreign", projectId: "p1" } }),
    );
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("rejects an invalid Work id without a lookup", async () => {
    const r = await refreshAdsPulseAction("p1", "");
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.workFindFirst).not.toHaveBeenCalled();
  });

  it("returns the stored digest inside the 5 minute window without a Graph call", async () => {
    mocks.credentialFindUnique.mockResolvedValue(
      credential(digestAt(new Date(NOW.getTime() - 4 * 60_000))),
    );
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toEqual({ ok: true, state: "throttled" });
    expect(mocks.resolveConnection).not.toHaveBeenCalled();
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("calls Meta once the stored digest is older than 5 minutes", async () => {
    mocks.credentialFindUnique.mockResolvedValue(
      credential(digestAt(new Date(NOW.getTime() - 6 * 60_000))),
    );
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toEqual({ ok: true, state: "refreshed" });
    expect(mocks.campaigns).toHaveBeenCalledWith(
      expect.anything(),
      "last_7d",
      expect.anything(),
    );
  });

  it("maps Meta token error 190 to RECONNECT and persists nothing", async () => {
    mocks.campaigns.mockRejectedValue(new MetaApiError("token expired", 190));
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toMatchObject({ ok: false, code: "RECONNECT" });
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("maps any other read failure to FAILED without leaking the error", async () => {
    mocks.campaigns.mockRejectedValue(new MetaApiError("secret detail", 17));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toMatchObject({ ok: false, code: "FAILED" });
    expect(JSON.stringify(r)).not.toContain("secret detail");
    err.mockRestore();
  });

  it("answers NOT_CONNECTED for a missing or inactive credential and for a connection that is not ready", async () => {
    mocks.credentialFindUnique.mockResolvedValue(null);
    expect(await refreshAdsPulseAction("p1", "w1")).toMatchObject({
      ok: false,
      code: "NOT_CONNECTED",
    });
    mocks.credentialFindUnique.mockResolvedValue({
      ...credential(),
      status: "REVOKED",
    });
    expect(await refreshAdsPulseAction("p1", "w1")).toMatchObject({
      ok: false,
      code: "NOT_CONNECTED",
    });
    mocks.credentialFindUnique.mockResolvedValue(credential());
    mocks.resolveConnection.mockResolvedValue({ status: "NOT_CONNECTED" });
    expect(await refreshAdsPulseAction("p1", "w1")).toMatchObject({
      ok: false,
      code: "NOT_CONNECTED",
    });
    mocks.resolveConnection.mockResolvedValue({ status: "NO_AD_ACCOUNT" });
    const noAccount = await refreshAdsPulseAction("p1", "w1");
    expect(noAccount).toMatchObject({ ok: false, code: "NOT_CONNECTED" });
    expect(noAccount.ok === false && noAccount.message).toMatch(/ad account/);
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("persists ONLY the digest key with ONE atomic jsonb_set statement on an ACTIVE credential", async () => {
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toEqual({ ok: true, state: "refreshed" });

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("jsonb_set(coalesce(metadata, '{}'::jsonb), '{adsDigest}'");
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain("WHERE id =");
    expect(sql).not.toContain("selectedAdAccountId");
    expect(values).toHaveLength(2);
    expect(values[1]).toBe("cred1");
    expect(values.join(" ")).not.toContain("selectedAdAccountId");

    const digest = JSON.parse(values[0] as string) as {
      at: string;
      currency: string;
      adAccountId?: string;
      campaigns: { id: string; costPerResult?: number; costChangePct?: number }[];
    };
    expect(digest.at).toBe(NOW.toISOString());
    // Bound to the account the numbers were read from.
    expect(digest.adAccountId).toBe("act_1");
    expect(digest.currency).toBe("TRY");
    expect(digest.campaigns.map((c) => c.id)).toEqual(["c1"]);
    // 30 (stored digest) -> 36: +20% vs last check.
    expect(digest.campaigns[0]).toMatchObject({
      costPerResult: 36,
      costChangePct: 20,
    });

    // Never a whole-metadata update.
    expect(mocks.credentialUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("a stored digest of ANOTHER ad account neither throttles nor feeds the comparison", async () => {
    // Fresh digest (1 min old) but read from act_OLD; act_1 is selected now.
    mocks.credentialFindUnique.mockResolvedValue(
      credential({
        ...digestAt(new Date(NOW.getTime() - 60_000)),
        adAccountId: "act_OLD",
      }),
    );
    const r = await refreshAdsPulseAction("p1", "w1");
    expect(r).toEqual({ ok: true, state: "refreshed" });
    expect(mocks.campaigns).toHaveBeenCalledTimes(1);
    const [, json] = mocks.executeRaw.mock.calls[0] as [unknown, string];
    const digest = JSON.parse(json) as {
      adAccountId: string;
      campaigns: { costChangePct?: number }[];
    };
    expect(digest.adAccountId).toBe("act_1");
    // No "+x% vs last check" across two different accounts.
    expect(digest.campaigns[0]?.costChangePct).toBeUndefined();
  });

  it("reads campaigns with the same lead preference the scanner uses", async () => {
    await refreshAdsPulseAction("p1", "w1");
    expect(mocks.campaigns).toHaveBeenCalledWith(expect.anything(), "last_7d", {
      preferLeadForLeadsCampaigns: true,
    });
  });

  it("never shows a vs-last-check percentage across two different result names", async () => {
    mocks.credentialFindUnique.mockResolvedValue(
      credential({
        ...digestAt(new Date(NOW.getTime() - 60 * 60_000)),
        campaigns: [
          {
            id: "c1",
            name: "Leads",
            dailyBudgetCents: 40000,
            spend: 100,
            resultLabel: "Link Clicks",
            costPerResult: 2,
          },
        ],
      }),
    );
    await refreshAdsPulseAction("p1", "w1");
    const [, json] = mocks.executeRaw.mock.calls[0] as [unknown, string];
    const digest = JSON.parse(json) as {
      campaigns: { costChangePct?: number; prevCostPerResult?: number }[];
    };
    expect(digest.campaigns[0]?.costChangePct).toBeUndefined();
    expect(digest.campaigns[0]?.prevCostPerResult).toBeUndefined();
  });

  it("writes no chat row", async () => {
    await refreshAdsPulseAction("p1", "w1");
    expect(mocks.commandCreate).not.toHaveBeenCalled();
  });

  it("imports no LLM or chat module and never rewrites whole metadata (source check)", () => {
    const source = readFileSync(
      "src/server/actions/work-ads-actions.ts",
      "utf8",
    );
    expect(source).not.toMatch(/from "openai"|openai-|@\/server\/chat|@\/server\/reasoning/);
    expect(source).not.toMatch(/integrationCredential\.update/);
    expect(source).not.toMatch(/selectedAdAccountId:/);
  });
});

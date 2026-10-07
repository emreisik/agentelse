import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink } from "@prisma/client";

import { GSC_SYNC_LEASE_MS } from "@/lib/seo/schedule";

// Bu dosyanın kanıtladığı: geri doldurmadaki ağır blok (HEAVY) aynı turdaki
// günlük aşamayı durdurmaz ve kilidi hiçbir zaman bir kilit süresinden uzun
// tutmaz; LOAD ertelemesi kilidi Google'ın açacağı ana kadar tutar; geliştirme
// süreci (canlı DB paylaşılırken) heartbeat yazmaz, claimPeriodic almaz ve
// yalnız GSC_SYNC_DEV_PROJECTS'teki projelere bakar; yeni bağ ilk turunda
// günlük aşamadan sonra haftalık ve geri doldurmaya da başlar.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  credentials: vi.fn(),
  credential: vi.fn(),
  projects: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
  claimPeriodic: vi.fn(),
  ensureLinks: vi.fn(),
  ensureLinkForProject: vi.fn(),
  brandContext: vi.fn(),
  metadata: vi.fn(),
  daily: vi.fn(),
  weekly: vi.fn(),
  monthly: vi.fn(),
  backfill: vi.fn(),
  clearBrand: vi.fn(),
  token: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    integrationCredential: {
      findMany: mocks.credentials,
      findUnique: mocks.credential,
    },
    project: { findMany: mocks.projects },
  },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => true,
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.token,
}));
vi.mock("@/server/seo/brand-terms", () => ({
  brandContextForLink: mocks.brandContext,
}));
vi.mock("./links", () => ({
  ensureGscLinks: mocks.ensureLinks,
  ensureGscLinkForProject: mocks.ensureLinkForProject,
}));
vi.mock("./metadata", () => ({ syncMetadata: mocks.metadata }));
vi.mock("./daily", () => ({ syncDaily: mocks.daily }));
vi.mock("./weekly", () => ({ syncWeekly: mocks.weekly }));
vi.mock("./monthly", () => ({ syncMonthly: mocks.monthly }));
vi.mock("./backfill", () => ({ syncBackfill: mocks.backfill }));
vi.mock("./write", () => ({ clearBrandSeries: mocks.clearBrand }));

const { GscSync } = await import("./runner");
const { GscQuotaDeferred } = await import("./requests");

const NOW = new Date("2026-10-06T15:00:00Z");

function link(overrides: Partial<GscSiteLink> = {}): GscSiteLink {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    credentialId: "cred-1",
    siteUrl: "sc-domain:example.com",
    isPrimary: true,
    isSecondary: false,
    demotedAt: null,
    isMock: true,
    propertyType: "DOMAIN",
    permissionLevel: "siteOwner",
    domainMatch: true,
    searchTypes: null,
    brandTerms: null,
    brandSeriesHash: null,
    brandClassifiedHash: null,
    archive: true,
    health: "UNKNOWN",
    healthReason: null,
    rateLimitedUntil: null,
    loadLimitedUntil: null,
    heavyLimitedUntil: null,
    loadErrors: null,
    syncLeaseUntil: null,
    syncLeaseOwner: null,
    consecutiveFailures: 0,
    lastSyncError: null,
    lastMetadataAt: null,
    lastDailyAt: null,
    lastDailySlot: null,
    lastFinalDate: null,
    lastFreshAt: null,
    lastWeeklyWeek: null,
    lastMonthlyMonth: null,
    backfill: null,
    backfillDoneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

let current: GscSiteLink;

// Günlük aşama kesin günü yazar (yeniden okunan bağ bunu görür).
function dailyWritesFinalDate() {
  mocks.daily.mockImplementation(async () => {
    current = { ...current, lastFinalDate: "2026-10-03", lastDailyAt: NOW };
  });
}

function leaseWrites(): Date[] {
  return mocks.updateMany.mock.calls
    .map((call) => (call[0] as { data: { syncLeaseUntil?: unknown } }).data)
    .map((data) => data.syncLeaseUntil)
    .filter((value): value is Date => value instanceof Date);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GSC_SYNC", "true");
  current = link();
  mocks.findMany.mockImplementation(async () => [current]);
  mocks.findUnique.mockImplementation(async () => current);
  mocks.update.mockImplementation(async () => current);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.credentials.mockResolvedValue([
    { id: "cred-1", status: "ACTIVE", encryptedSecret: "secret" },
  ]);
  mocks.projects.mockResolvedValue([{ id: "p-1", status: "ACTIVE" }]);
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.ensureLinks.mockResolvedValue(0);
  mocks.ensureLinkForProject.mockResolvedValue(undefined);
  mocks.brandContext.mockResolvedValue({
    terms: ["acme"],
    regex: "(?i)acme",
    hash: "h1",
  });
  for (const stage of [
    mocks.metadata,
    mocks.daily,
    mocks.weekly,
    mocks.monthly,
    mocks.backfill,
  ]) {
    stage.mockResolvedValue(undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GscSync.runDue", () => {
  it("returns 0 at once when GSC_SYNC is off", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    expect(await GscSync.runDue(3, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
  });

  it("starts weekly, monthly and backfill in the same run after the first daily stage", async () => {
    dailyWritesFinalDate();
    expect(await GscSync.runDue(3, NOW)).toBe(1);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    expect(mocks.daily).toHaveBeenCalledTimes(1);
    expect(mocks.weekly).toHaveBeenCalledTimes(1);
    expect(mocks.monthly).toHaveBeenCalledTimes(1);
    expect(mocks.backfill).toHaveBeenCalledTimes(1);
    expect(mocks.daily.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.backfill.mock.invocationCallOrder[0]!,
    );
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { id: "link-1", syncLeaseOwner: expect.any(String) },
      data: expect.objectContaining({ syncLeaseUntil: null, health: "OK" }),
    });
  });

  it("keeps going after a heavy block inside the backfill stage and never holds the lease longer than one lease", async () => {
    dailyWritesFinalDate();
    mocks.backfill.mockRejectedValue(
      new GscQuotaDeferred(new Date(NOW.getTime() + 10 * 3_600_000), "HEAVY"),
    );
    mocks.weekly.mockRejectedValue(
      new GscQuotaDeferred(new Date(NOW.getTime() + 10 * 3_600_000), "HEAVY"),
    );
    await GscSync.runDue(3, NOW);
    expect(mocks.daily).toHaveBeenCalledTimes(1);
    // Haftalıkta blok: aylık ve geri doldurma yine çalışır.
    expect(mocks.monthly).toHaveBeenCalledTimes(1);
    expect(mocks.backfill).toHaveBeenCalledTimes(1);
    const limit = Date.now() + GSC_SYNC_LEASE_MS;
    for (const until of leaseWrites()) {
      expect(until.getTime()).toBeLessThanOrEqual(limit);
    }
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ syncLeaseUntil: null, health: "OK" }),
      }),
    );
  });

  it("holds a heavy deferral that reaches onFailure to at most one lease", async () => {
    await GscSync.onFailure(
      {
        link: current,
        quota: {
          rateLimitedUntil: null,
          loadLimitedUntil: null,
          heavyLimitedUntil: null,
          loadErrors: null,
        },
      } as Parameters<typeof GscSync.onFailure>[0],
      "owner",
      new GscQuotaDeferred(new Date(Date.now() + 10 * 3_600_000), "HEAVY"),
    );
    const [until] = leaseWrites();
    expect(until!.getTime()).toBeLessThanOrEqual(
      Date.now() + GSC_SYNC_LEASE_MS,
    );
  });

  it("keeps the lease until Google lifts a load block", async () => {
    const retryAt = new Date(Date.now() + 15 * 60_000);
    mocks.daily.mockRejectedValue(new GscQuotaDeferred(retryAt, "LOAD"));
    await GscSync.runDue(3, NOW);
    expect(mocks.weekly).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { id: "link-1", syncLeaseOwner: expect.any(String) },
      data: { syncLeaseUntil: retryAt, syncLeaseOwner: null },
    });
  });

  it("writes no heartbeat, takes no periodic key and only syncs allow-listed projects on a dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@ep-live.neon.tech/db");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "p-dev");
    await GscSync.runDue(3, NOW);
    expect(mocks.beat).not.toHaveBeenCalled();
    expect(mocks.ok).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.ensureLinks).not.toHaveBeenCalled();
    expect(mocks.ensureLinkForProject).toHaveBeenCalledWith("p-dev");
    for (const call of mocks.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({
        isMock: true,
        projectId: { in: ["p-dev"] },
      });
    }
    // p-1 listede değil: senkronlanmaz.
    expect(mocks.daily).not.toHaveBeenCalled();
  });

  it("beats the heartbeat and reconciles links globally elsewhere", async () => {
    await GscSync.runDue(3, NOW);
    expect(mocks.beat).toHaveBeenCalledWith("gsc.sync", NOW);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith("gsc.links", 120_000, NOW);
    expect(mocks.ensureLinks).toHaveBeenCalledTimes(1);
  });

  it("issues exactly the two primary queries when GSC_AGENCY is off (SC-F9)", async () => {
    await GscSync.runDue(3, NOW);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    for (const call of mocks.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ isPrimary: true });
      expect(call[0].where).not.toHaveProperty("isSecondary");
    }
  });

  it("adds two small secondary queries when GSC_AGENCY is on and keeps primaries ahead of at most 2 secondaries per tick (400 links, SC-F9)", async () => {
    vi.stubEnv("GSC_AGENCY", "true");
    const primaries = Array.from({ length: 2 }, (_, i) =>
      link({ id: `primary-${i}`, projectId: `pp-${i}`, credentialId: "cred-1" }),
    );
    const secondaries = Array.from({ length: 398 }, (_, i) =>
      link({
        id: `secondary-${i}`,
        projectId: `ps-${i}`,
        isPrimary: false,
        isSecondary: true,
        siteUrl: `https://s${i}.example.com/`,
      }),
    );
    mocks.findMany.mockImplementation(
      async (args: { where: { isSecondary?: boolean }; take: number }) =>
        (args.where.isSecondary ? secondaries : primaries).slice(0, args.take),
    );
    mocks.projects.mockResolvedValue(
      [...primaries, ...secondaries].map((row) => ({
        id: row.projectId,
        status: "ACTIVE",
      })),
    );
    const all = [...primaries, ...secondaries];
    mocks.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        all.find((row) => row.id === args.where.id) ?? null,
    );
    expect(await GscSync.runDue(10, NOW)).toBe(4);
    expect(mocks.findMany).toHaveBeenCalledTimes(4);
    const first = mocks.metadata.mock.calls.map(
      (call) => (call[0] as { link: GscSiteLink }).link.id,
    );
    expect(first.slice(0, 2)).toEqual(["primary-0", "primary-1"]);
    expect(first.filter((id) => id.startsWith("secondary-"))).toHaveLength(2);
  });

  it("marks the link AUTH when its credential is gone", async () => {
    mocks.credentials.mockResolvedValue([]);
    await GscSync.runDue(3, NOW);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { health: "AUTH", healthReason: "Reconnect Search Console" },
    });
    expect(mocks.daily).not.toHaveBeenCalled();
  });
});

describe("GscSync.refreshNow", () => {
  it("re-fetches only the daily window and throttles to once per 5 minutes", async () => {
    current = link({
      lastMetadataAt: NOW,
      lastDailyAt: new Date(NOW.getTime() - 60_000),
    });
    mocks.findFirst.mockImplementation(async () => current);
    mocks.credential.mockResolvedValue({
      id: "cred-1",
      status: "ACTIVE",
      encryptedSecret: "secret",
    });
    expect(await GscSync.refreshNow("p-1", NOW)).toBe("throttled");

    const later = new Date(NOW.getTime() + 10 * 60_000);
    mocks.daily.mockImplementation(async () => {
      current = { ...current, lastDailyAt: later, lastFinalDate: "2026-10-03" };
    });
    expect(await GscSync.refreshNow("p-1", later)).toBe("refreshed");
    expect(mocks.daily).toHaveBeenCalledTimes(1);
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.weekly).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });
});

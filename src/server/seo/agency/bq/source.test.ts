import type { GscBqSource, GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: kaynak görünümü bayrak kapalıyken sorgu yapmaz ve
// JSON'a güvenle çevrilir (BigInt yok); kaydetme mülk sahibi olmayanı reddeder,
// kimlikleri doğrular, tavanları sert sınırlara kırpar ve veri kümesi
// değişince DRAFT'a döner; açma yalnız son 24 saatteki doğrulamadan sonra
// olur; kaldırma yalnız kaynak satırını siler.

const prisma = vi.hoisted(() => ({
  gscSiteLink: { findFirst: vi.fn() },
  gscBqSource: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  gscPeriodFetch: { groupBy: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma }));
const record = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record },
}));

const { loadBqSourceView, saveBqSource, setBqSourceState, addBqUsage } =
  await import("./source");

const GIB = 1024 ** 3;
const NOW = new Date("2026-10-07T12:00:00Z");

const link = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  siteUrl: "sc-domain:example.com",
  isMock: false,
  isPrimary: true,
  isSecondary: false,
  permissionLevel: "siteOwner",
} as unknown as GscSiteLink;

function source(over: Partial<GscBqSource> = {}): GscBqSource {
  return {
    id: "src-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    siteUrl: "sc-domain:example.com",
    isMock: false,
    status: "VERIFIED",
    bqProjectId: "my-cloud-proj",
    dataset: "searchconsole",
    location: "US",
    bqSiteUrl: "sc-domain:example.com",
    exportStart: "2026-06-09",
    exportedThrough: "2026-10-04",
    importAll: false,
    maxBytesPerQuery: BigInt(10 * GIB),
    monthlyBudgetBytes: BigInt(300 * GIB),
    usageMonth: "2026-10",
    bytesBilledMonth: BigInt(5 * GIB),
    queriesMonth: 7,
    lastVerifiedAt: new Date("2026-10-07T06:00:00Z"),
    lastSyncAt: null,
    lastError: null,
    reconcile: {
      checkedAt: "2026-10-07T06:00:00.000Z",
      days: 14,
      clicksDiffPct: 0.4,
      impressionsDiffPct: -0.2,
    },
    ...over,
  } as unknown as GscBqSource;
}

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  vi.stubEnv("GSC_BQ_HARD_MAX_BYTES", "");
  vi.stubEnv("GSC_BQ_HARD_MONTHLY_BYTES", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  for (const group of Object.values(prisma)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  record.mockReset();
  record.mockResolvedValue({});
  prisma.gscSiteLink.findFirst.mockResolvedValue({ ...link, isMock: true });
  prisma.gscBqSource.findUnique.mockResolvedValue(null);
  prisma.gscBqSource.create.mockResolvedValue({ id: "src-new" });
  prisma.gscBqSource.update.mockResolvedValue({});
  prisma.gscBqSource.updateMany.mockResolvedValue({ count: 1 });
  prisma.gscBqSource.delete.mockResolvedValue({});
  prisma.gscPeriodFetch.groupBy.mockResolvedValue([]);
});

describe("loadBqSourceView", () => {
  it("returns null without any query when the flag is off", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    expect(await loadBqSourceView("proj-1", "link-1")).toBeNull();
    expect(prisma.gscSiteLink.findFirst).not.toHaveBeenCalled();
  });

  it("returns null for a link that is not the project's", async () => {
    prisma.gscSiteLink.findFirst.mockResolvedValue(null);
    expect(await loadBqSourceView("proj-1", "other")).toBeNull();
  });

  it("returns an OFF view when no source exists", async () => {
    const view = await loadBqSourceView("proj-1", "link-1");
    expect(view).toMatchObject({
      linkId: "link-1",
      status: "OFF",
      configured: true,
      isOwner: true,
      serviceAccountEmail: "agentelse-reader@mock-project.iam.gserviceaccount.com",
      bqProjectId: null,
      dataset: null,
      importAll: false,
      maxBytesPerQuery: 10 * GIB,
      monthlyBudgetBytes: 300 * GIB,
      usedBytesMonth: 0,
      reconcile: null,
      imported: { weeks: 0, months: 0, lastWeek: null },
    });
  });

  it("maps a source, converts BigInt columns and survives JSON", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(
      source({ status: "ERROR", lastError: "NO_ACCESS", isMock: true }),
    );
    prisma.gscPeriodFetch.groupBy.mockResolvedValue([
      { grain: "WEEK", _count: { _all: 12 }, _max: { periodStart: new Date("2026-09-28T00:00:00Z") } },
      { grain: "MONTH", _count: { _all: 2 }, _max: { periodStart: new Date("2026-09-01T00:00:00Z") } },
    ]);
    const view = await loadBqSourceView("proj-1", "link-1");
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(view).toMatchObject({
      status: "ERROR",
      bqProjectId: "my-cloud-proj",
      maxBytesPerQuery: 10 * GIB,
      monthlyBudgetBytes: 300 * GIB,
      queriesMonth: 7,
      lastError: "NO_ACCESS",
      imported: { weeks: 12, months: 2, lastWeek: "2026-09-28" },
      reconcile: { days: 14, clicksDiffPct: 0.4, impressionsDiffPct: -0.2 },
    });
    expect(view?.errorText).toContain("BigQuery Data Viewer");
    // 2026-06-09 … 2026-10-04: 2026-06-15 Pazartesi'den 2026-09-28'e 16 tam hafta
    expect(view?.completeWeeks).toBe(16);
    expect(prisma.gscPeriodFetch.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.gscBqSource.findUnique).toHaveBeenCalledTimes(1);
  });

  it("shows a non-owner as not owner", async () => {
    prisma.gscSiteLink.findFirst.mockResolvedValue({
      ...link,
      isMock: true,
      permissionLevel: "siteRestrictedUser",
    });
    expect((await loadBqSourceView("proj-1", "link-1"))?.isOwner).toBe(false);
  });
});

const baseSave = {
  projectId: "proj-1",
  linkId: "link-1",
  bqProjectId: "my-cloud-proj",
  dataset: "searchconsole",
  maxBytesPerQuery: 10 * GIB,
  monthlyBudgetBytes: 300 * GIB,
  importAll: false,
  userId: "user-1",
};

describe("saveBqSource", () => {
  it("refuses a non-owner without writing", async () => {
    prisma.gscSiteLink.findFirst.mockResolvedValue({
      ...link,
      isMock: true,
      permissionLevel: "siteFullUser",
    });
    const out = await saveBqSource(baseSave);
    expect(out).toEqual({
      ok: false,
      message: "Only the Search Console property owner can connect a BigQuery export.",
    });
    expect(prisma.gscBqSource.create).not.toHaveBeenCalled();
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
  });

  it("refuses when the flag is off or the link is unknown", async () => {
    prisma.gscSiteLink.findFirst.mockResolvedValue(null);
    expect((await saveBqSource(baseSave)).ok).toBe(false);
    vi.stubEnv("GSC_BIGQUERY", "");
    expect((await saveBqSource(baseSave)).ok).toBe(false);
  });

  it("validates the project id and dataset", async () => {
    expect((await saveBqSource({ ...baseSave, bqProjectId: "Bad Id" })).ok).toBe(false);
    expect((await saveBqSource({ ...baseSave, bqProjectId: "ab" })).ok).toBe(false);
    expect((await saveBqSource({ ...baseSave, dataset: "a-b" })).ok).toBe(false);
    expect((await saveBqSource({ ...baseSave, dataset: "x`; DROP" })).ok).toBe(false);
    expect(prisma.gscBqSource.create).not.toHaveBeenCalled();
  });

  it("creates a DRAFT source for an owner and writes an audit row", async () => {
    const out = await saveBqSource({ ...baseSave, importAll: true });
    expect(out).toEqual({ ok: true });
    expect(prisma.gscBqSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        siteUrl: "sc-domain:example.com",
        status: "DRAFT",
        bqProjectId: "my-cloud-proj",
        dataset: "searchconsole",
        importAll: true,
        maxBytesPerQuery: BigInt(10 * GIB),
        monthlyBudgetBytes: BigInt(300 * GIB),
        createdByUserId: "user-1",
      }),
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "gsc_bigquery.configured",
        entityType: "GscBqSource",
        entityId: "src-new",
        metadata: { linkId: "link-1", importAll: true },
      }),
    );
  });

  it("clamps the caps to the hard maxima", async () => {
    vi.stubEnv("GSC_BQ_HARD_MAX_BYTES", String(20 * GIB));
    vi.stubEnv("GSC_BQ_HARD_MONTHLY_BYTES", String(100 * GIB));
    await saveBqSource({
      ...baseSave,
      maxBytesPerQuery: 100 * GIB,
      monthlyBudgetBytes: 2000 * GIB,
    });
    const data = prisma.gscBqSource.create.mock.calls[0]![0].data;
    expect(data.maxBytesPerQuery).toBe(BigInt(20 * GIB));
    expect(data.monthlyBudgetBytes).toBe(BigInt(100 * GIB));
  });

  it("falls back to the defaults for junk caps", async () => {
    await saveBqSource({ ...baseSave, maxBytesPerQuery: Number.NaN, monthlyBudgetBytes: -1 });
    const data = prisma.gscBqSource.create.mock.calls[0]![0].data;
    expect(data.maxBytesPerQuery).toBe(BigInt(10 * GIB));
    expect(data.monthlyBudgetBytes).toBe(BigInt(300 * GIB));
  });

  it("resets to DRAFT when the dataset changes and keeps the usage counters", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(source({ status: "ACTIVE", isMock: true }));
    await saveBqSource({ ...baseSave, dataset: "other_dataset" });
    const data = prisma.gscBqSource.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      status: "DRAFT",
      dataset: "other_dataset",
      location: null,
      bqSiteUrl: null,
      exportStart: null,
      exportedThrough: null,
      lastVerifiedAt: null,
      nextRunAt: null,
    });
    expect(data).not.toHaveProperty("bytesBilledMonth");
    expect(data).not.toHaveProperty("queriesMonth");
    expect(data).not.toHaveProperty("usageMonth");
  });

  it("keeps the status when only the caps change", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(source({ status: "ACTIVE", isMock: true }));
    await saveBqSource({ ...baseSave, monthlyBudgetBytes: 100 * GIB });
    const data = prisma.gscBqSource.update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("status");
    expect(data.monthlyBudgetBytes).toBe(BigInt(100 * GIB));
  });

  it("refuses a source that exists in the other mode", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(source({ isMock: false }));
    expect((await saveBqSource(baseSave)).ok).toBe(false);
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
  });
});

const base = { projectId: "proj-1", linkId: "link-1", userId: "user-1", now: NOW };

describe("setBqSourceState", () => {
  beforeEach(() => {
    prisma.gscBqSource.findUnique.mockResolvedValue(source({ isMock: true }));
  });

  it("turns a verified source ON within 24 hours", async () => {
    expect(await setBqSourceState({ ...base, state: "ON" })).toEqual({ ok: true });
    expect(prisma.gscBqSource.update).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: { status: "ACTIVE", nextRunAt: null, lastError: null, consecutiveFailures: 0 },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_bigquery.enabled" }),
    );
  });

  it("refuses ON when the verification is older than 24 hours", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(
      source({ isMock: true, lastVerifiedAt: new Date("2026-10-05T11:00:00Z") }),
    );
    const out = await setBqSourceState({ ...base, state: "ON" });
    expect(out.ok).toBe(false);
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
  });

  it("refuses ON for DRAFT and ERROR sources (verify first)", async () => {
    for (const status of ["DRAFT", "ERROR"]) {
      prisma.gscBqSource.findUnique.mockResolvedValue(source({ isMock: true, status }));
      expect((await setBqSourceState({ ...base, state: "ON" })).ok).toBe(false);
    }
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
  });

  it("refuses ON for a non-owner", async () => {
    prisma.gscSiteLink.findFirst.mockResolvedValue({
      ...link,
      isMock: true,
      permissionLevel: "siteFullUser",
    });
    const out = await setBqSourceState({ ...base, state: "ON" });
    expect(out).toEqual({
      ok: false,
      message: "Only the Search Console property owner can connect a BigQuery export.",
    });
  });

  it("refuses ON from BUDGET while the budget is still used up", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(
      source({
        isMock: true,
        status: "BUDGET",
        bytesBilledMonth: BigInt(300 * GIB),
      }),
    );
    expect((await setBqSourceState({ ...base, state: "ON" })).ok).toBe(false);
    prisma.gscBqSource.findUnique.mockResolvedValue(
      source({
        isMock: true,
        status: "BUDGET",
        bytesBilledMonth: BigInt(300 * GIB),
        monthlyBudgetBytes: BigInt(1000 * GIB),
      }),
    );
    expect((await setBqSourceState({ ...base, state: "ON" })).ok).toBe(true);
  });

  it("pauses a source", async () => {
    expect(await setBqSourceState({ ...base, state: "PAUSE" })).toEqual({ ok: true });
    expect(prisma.gscBqSource.update).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: { status: "PAUSED", nextRunAt: null },
    });
  });

  it("removes only the source row (imported rows stay)", async () => {
    expect(await setBqSourceState({ ...base, state: "REMOVE" })).toEqual({ ok: true });
    expect(prisma.gscBqSource.delete).toHaveBeenCalledWith({ where: { id: "src-1" } });
    // Ambar tablolarına dokunan başka bir silme mock'ta bile yok.
    expect(Object.keys(prisma)).toEqual(["gscSiteLink", "gscBqSource", "gscPeriodFetch"]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_bigquery.removed" }),
    );
  });

  it("refuses everything when the source is missing, the link unknown or the flag off", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(null);
    expect((await setBqSourceState({ ...base, state: "PAUSE" })).ok).toBe(false);
    prisma.gscSiteLink.findFirst.mockResolvedValue(null);
    expect((await setBqSourceState({ ...base, state: "PAUSE" })).ok).toBe(false);
    vi.stubEnv("GSC_BIGQUERY", "");
    prisma.gscSiteLink.findFirst.mockClear();
    expect((await setBqSourceState({ ...base, state: "PAUSE" })).ok).toBe(false);
    expect(prisma.gscSiteLink.findFirst).not.toHaveBeenCalled();
  });
});

describe("addBqUsage", () => {
  it("rolls the counters over and increments atomically", async () => {
    await addBqUsage("src-1", 1_500_000, 2, NOW);
    expect(prisma.gscBqSource.updateMany).toHaveBeenCalledWith({
      where: {
        id: "src-1",
        OR: [{ usageMonth: null }, { usageMonth: { not: "2026-10" } }],
      },
      data: { usageMonth: "2026-10", bytesBilledMonth: BigInt(0), queriesMonth: 0 },
    });
    expect(prisma.gscBqSource.update).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: {
        bytesBilledMonth: { increment: BigInt(1_500_000) },
        queriesMonth: { increment: 2 },
      },
    });
  });
});

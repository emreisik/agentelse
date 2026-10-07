import type { GscBqSource, GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BigQueryError, type BigQueryClient } from "@/server/integrations/google/bigquery";

// Bu dosyanın kanıtladığı: her tur sahipliği ve mülk eşleşmesini yeniden
// denetler (NOT_OWNER, SITE_MISMATCH → ERROR); kaynak ve bağ kilitleri CAS ile
// alınır; durum geçişleri (BUDGET, ERROR, geri çekilme); faturalanan bayt
// sayaca yazılır; 20 sn'den az kalınca dönem başlatılmaz; içe aktarmadan sonra
// kural varsa sayfa grupları yeniden uygulanır; bayrak kapalıyken veritabanına
// gidilmez; geliştirme koruması izinli projelerle sınırlar.

const prisma = vi.hoisted(() => ({
  gscBqSource: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  gscSiteLink: { findUnique: vi.fn(), updateMany: vi.fn() },
  gscPeriodFetch: { findMany: vi.fn() },
  integrationCredential: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma }));

const readBqPeriod = vi.hoisted(() => vi.fn());
vi.mock("./reader", () => ({ readBqPeriod }));
const readBqCoverage = vi.hoisted(() => vi.fn());
vi.mock("./verify", () => ({ readBqCoverage }));
vi.mock("./mock-export", () => ({}));
const addBqUsage = vi.hoisted(() => vi.fn());
vi.mock("./source", async (original) => ({
  ...(await original<typeof import("./source")>()),
  addBqUsage,
}));
const writePeriod = vi.hoisted(() => vi.fn());
vi.mock("@/server/seo/sync/write", () => ({ writePeriod }));
const regroupLink = vi.hoisted(() => vi.fn());
const pageGroupRulesForLink = vi.hoisted(() => vi.fn());
vi.mock("@/server/seo/agency/page-groups", () => ({
  GscPageGroups: { regroupLink },
  pageGroupRulesForLink,
}));
const brandContextForLink = vi.hoisted(() => vi.fn());
vi.mock("@/server/seo/brand-terms", () => ({ brandContextForLink }));

const { GscBigQuerySync } = await import("./sync");

const NOW = new Date("2026-10-07T19:00:00Z"); // PT günü 2026-10-07
const GIB = 1024 ** 3;
const SOURCE_ID = "src-1";

const link = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  siteUrl: "sc-domain:example.com",
  isMock: false,
  isPrimary: true,
  isSecondary: false,
  permissionLevel: "siteOwner",
  searchTypes: null,
  rateLimitedUntil: null,
  loadLimitedUntil: null,
  heavyLimitedUntil: null,
  loadErrors: null,
} as unknown as GscSiteLink;

function sourceRow(over: Partial<GscBqSource> = {}): GscBqSource {
  return {
    id: SOURCE_ID,
    workspaceId: "ws-1",
    projectId: "proj-1",
    siteUrl: "sc-domain:example.com",
    isMock: false,
    status: "ACTIVE",
    bqProjectId: "my-cloud-proj",
    dataset: "searchconsole",
    location: "US",
    bqSiteUrl: "sc-domain:example.com",
    // Tek tam hafta (09-28 … 10-04): 3 dönem anahtarı, dışa aktarım güncel
    exportStart: "2026-09-24",
    exportedThrough: "2026-10-04",
    coverageCheckedAt: new Date("2026-10-07T18:00:00Z"),
    importAll: false,
    maxBytesPerQuery: BigInt(10 * GIB),
    monthlyBudgetBytes: BigInt(300 * GIB),
    usageMonth: "2026-10",
    bytesBilledMonth: BigInt(0),
    queriesMonth: 0,
    consecutiveFailures: 0,
    nextRunAt: null,
    leaseUntil: null,
    ...over,
  } as unknown as GscBqSource;
}

const client = {} as BigQueryClient;
const okRead = (billedBytes = 41_000_000) => ({
  ok: true,
  billedBytes,
  result: {
    rows: [],
    pages: 1,
    truncated: false,
    firstIncompleteDate: null,
    responseAggregationType: "auto",
  },
});

function run(over: { deadlineAt?: number } = {}) {
  return GscBigQuerySync.syncSource(SOURCE_ID, { now: NOW, client, ...over });
}

// Kaynağa yazılan son durum güncellemesi (kilit bırakma updateMany ayrı).
function finalData(): Record<string, unknown> {
  const calls = prisma.gscBqSource.update.mock.calls;
  return calls[calls.length - 1]![0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  for (const group of Object.values(prisma)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  for (const mock of [
    readBqPeriod,
    readBqCoverage,
    addBqUsage,
    writePeriod,
    regroupLink,
    pageGroupRulesForLink,
    brandContextForLink,
  ]) {
    mock.mockReset();
  }
  prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow());
  prisma.gscBqSource.update.mockResolvedValue({});
  prisma.gscBqSource.updateMany.mockResolvedValue({ count: 1 });
  prisma.gscSiteLink.findUnique.mockResolvedValue(link);
  prisma.gscSiteLink.updateMany.mockResolvedValue({ count: 1 });
  prisma.gscPeriodFetch.findMany.mockResolvedValue([]);
  prisma.integrationCredential.findUnique.mockResolvedValue({ status: "ACTIVE" });
  readBqPeriod.mockResolvedValue(okRead());
  addBqUsage.mockResolvedValue(undefined);
  writePeriod.mockResolvedValue(undefined);
  regroupLink.mockResolvedValue({ updated: 0, done: true });
  pageGroupRulesForLink.mockResolvedValue(null);
  brandContextForLink.mockResolvedValue(null);
});

describe("a successful run", () => {
  it("imports every planned period through writePeriod with source BQ", async () => {
    const out = await run();
    expect(out).toEqual({ imported: 3, status: "ACTIVE", reason: null });
    expect(writePeriod).toHaveBeenCalledTimes(3);
    const [ctx, grain, start, key, result, source] = writePeriod.mock.calls[0]!;
    expect(grain).toBe("WEEK");
    expect(start).toBe("2026-09-28");
    expect(["query", "page", "query_page"]).toContain(key);
    expect(result).toMatchObject({ pages: 1, truncated: false });
    expect(source).toBe("BQ");
    expect(ctx).toMatchObject({
      accessToken: "",
      lane: "P2",
      requestsLeft: 0,
      today: "2026-10-07",
      now: NOW,
    });
    expect(ctx.link.id).toBe("link-1");
  });

  it("schedules the next run in 6 hours when nothing is pending", async () => {
    await run();
    const data = finalData();
    expect(data).toMatchObject({ consecutiveFailures: 0, lastSyncAt: NOW, lastError: null });
    expect(data.nextRunAt).toEqual(new Date(NOW.getTime() + 6 * 3_600_000));
  });

  it("schedules a quick follow-up when more periods are pending", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(
      sourceRow({ exportStart: "2026-06-09", exportedThrough: "2026-10-04" }),
    );
    const out = await run();
    expect(out.imported).toBe(6);
    expect(finalData().nextRunAt).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it("adds the billed bytes to the monthly usage right after each read", async () => {
    readBqPeriod.mockResolvedValue(okRead(123_456_789));
    await run();
    expect(addBqUsage).toHaveBeenCalledTimes(3);
    expect(addBqUsage).toHaveBeenCalledWith(SOURCE_ID, 123_456_789, 1, NOW);
  });

  it("feeds the running usage into the next read", async () => {
    readBqPeriod.mockResolvedValue(okRead(1_000));
    await run();
    const usages = readBqPeriod.mock.calls.map((call) => call[0].usage.bytesBilledMonth);
    expect(usages).toEqual([0, 1_000, 2_000]);
  });

  it("skips periods that are already stored (BQ) and plans API gaps", async () => {
    prisma.gscPeriodFetch.findMany.mockResolvedValue([
      { grain: "WEEK", periodStart: new Date("2026-09-28T00:00:00Z"), key: "query", source: "BQ", truncated: true },
      { grain: "WEEK", periodStart: new Date("2026-09-28T00:00:00Z"), key: "page", source: "API", truncated: false },
      { grain: "WEEK", periodStart: new Date("2026-09-28T00:00:00Z"), key: "query_page", source: "API", truncated: true },
    ]);
    const out = await run();
    expect(out.imported).toBe(1);
    expect(writePeriod.mock.calls[0]![3]).toBe("query_page");
  });

  it("imports complete API periods when importAll is set", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ importAll: true }));
    prisma.gscPeriodFetch.findMany.mockResolvedValue(
      ["query", "page", "query_page"].map((key) => ({
        grain: "WEEK",
        periodStart: new Date("2026-09-28T00:00:00Z"),
        key,
        source: "API",
        truncated: false,
      })),
    );
    expect((await run()).imported).toBe(3);
  });

  it("releases the link lease after every period and the source lease at the end", async () => {
    await run();
    const releases = prisma.gscSiteLink.updateMany.mock.calls.filter(
      (call) => call[0].data.syncLeaseOwner === null,
    );
    expect(releases).toHaveLength(3);
    const sourceRelease = prisma.gscBqSource.updateMany.mock.calls.at(-1)![0];
    expect(sourceRelease.data).toEqual({ leaseUntil: null, leaseOwner: null });
  });
});

describe("regroup after import", () => {
  it("regroups when imports happened and rules exist", async () => {
    pageGroupRulesForLink.mockResolvedValue({ v: 1, rules: [{ id: "r1", group: "/shop", match: "PREFIX", pattern: "/shop" }] });
    await run();
    expect(regroupLink).toHaveBeenCalledWith("link-1", { budgetMs: 15_000, now: NOW });
  });

  it("does not regroup without rules or without imports", async () => {
    await run();
    expect(regroupLink).not.toHaveBeenCalled();
    pageGroupRulesForLink.mockResolvedValue({ v: 1, rules: [{ id: "r1", group: "/shop", match: "PREFIX", pattern: "/shop" }] });
    readBqPeriod.mockResolvedValue({ ok: false, reason: "OVER_QUERY_CAP" });
    await run();
    expect(regroupLink).not.toHaveBeenCalled();
  });

  it("survives a failing regroup", async () => {
    pageGroupRulesForLink.mockResolvedValue({ v: 1, rules: [{ id: "r1", group: "/shop", match: "PREFIX", pattern: "/shop" }] });
    regroupLink.mockRejectedValue(new Error("boom"));
    expect((await run()).imported).toBe(3);
  });
});

describe("ownership and site re-checks on every run", () => {
  it("ends in ERROR NOT_OWNER when the permission dropped, without reading", async () => {
    prisma.gscSiteLink.findUnique.mockResolvedValue({ ...link, permissionLevel: "siteFullUser" });
    const out = await run();
    expect(out).toEqual({ imported: 0, status: "ERROR", reason: "NOT_OWNER" });
    expect(readBqPeriod).not.toHaveBeenCalled();
    expect(finalData()).toMatchObject({ status: "ERROR", lastError: "NOT_OWNER", nextRunAt: null });
  });

  it("ends in ERROR NOT_OWNER when the Search Console credential is no longer active", async () => {
    // İzin eski kalsa bile Google erişimi geri alınmışsa dataset okunmaz.
    for (const status of ["EXPIRED", "REVOKED"]) {
      prisma.gscBqSource.update.mockClear();
      prisma.integrationCredential.findUnique.mockResolvedValue({ status });
      const out = await run();
      expect(out).toEqual({ imported: 0, status: "ERROR", reason: "NOT_OWNER" });
    }
    prisma.integrationCredential.findUnique.mockResolvedValue(null);
    expect((await run()).reason).toBe("NOT_OWNER");
    expect(readBqPeriod).not.toHaveBeenCalled();
  });

  it("ends in ERROR NOT_OWNER when the link health says access is gone", async () => {
    for (const health of ["AUTH", "NEEDS_PERMISSION", "ACCESS_LOST", "GONE", "API_DISABLED"]) {
      prisma.gscSiteLink.findUnique.mockResolvedValue({ ...link, health });
      expect((await run()).reason).toBe("NOT_OWNER");
    }
    expect(readBqPeriod).not.toHaveBeenCalled();
    // Geçici DEGRADED sağlık içe aktarmayı durdurmaz.
    prisma.gscSiteLink.findUnique.mockResolvedValue({ ...link, health: "DEGRADED" });
    expect((await run()).imported).toBe(3);
  });

  it("charges the estimate to the monthly usage when a submitted query is left unfinished", async () => {
    readBqPeriod.mockImplementation(async (input: { onUnfinished: (bytes: number) => Promise<void> }) => {
      await input.onUnfinished(1234);
      throw new BigQueryError("TIMEOUT");
    });
    const out = await run();
    expect(out.reason).toBe("TIMEOUT");
    expect(addBqUsage).toHaveBeenCalledWith(SOURCE_ID, 1234, 1, NOW);
  });

  it("ends in ERROR SITE_MISMATCH when the stored site no longer matches the link", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ bqSiteUrl: "sc-domain:other.com" }));
    const out = await run();
    expect(out).toEqual({ imported: 0, status: "ERROR", reason: "SITE_MISMATCH" });
    expect(readBqPeriod).not.toHaveBeenCalled();
  });

  it("treats a missing verified site as a mismatch", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ bqSiteUrl: null }));
    expect((await run()).reason).toBe("SITE_MISMATCH");
  });

  it("accepts a different letter case and a trailing slash", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ bqSiteUrl: "SC-DOMAIN:Example.com/" }));
    expect((await run()).imported).toBe(3);
  });

  it("pauses the source when the link is gone", async () => {
    prisma.gscSiteLink.findUnique.mockResolvedValue(null);
    const out = await run();
    expect(out).toEqual({ imported: 0, status: "PAUSED", reason: "NO_LINK" });
    expect(finalData()).toMatchObject({ status: "PAUSED", nextRunAt: null });
  });
});

describe("outcomes of a period", () => {
  it("goes to BUDGET when the monthly budget is used up", async () => {
    readBqPeriod.mockResolvedValue({ ok: false, reason: "OVER_MONTHLY_BUDGET" });
    const out = await run();
    expect(out).toMatchObject({ imported: 0, status: "BUDGET" });
    expect(finalData()).toMatchObject({ status: "BUDGET", nextRunAt: null });
    expect(writePeriod).not.toHaveBeenCalled();
  });

  it("skips an over-cap period, keeps the source ACTIVE and continues", async () => {
    readBqPeriod
      .mockResolvedValueOnce({ ok: false, reason: "OVER_QUERY_CAP" })
      .mockResolvedValue(okRead());
    const out = await run();
    expect(out).toEqual({ imported: 2, status: "ACTIVE", reason: "PERIOD_TOO_BIG" });
    const data = finalData();
    expect(data.lastError).toBe("PERIOD_TOO_BIG");
    expect(data).not.toHaveProperty("status");
  });

  it("treats a billed-bytes overrun like an over-cap period", async () => {
    readBqPeriod.mockRejectedValueOnce(new BigQueryError("COST_CAP")).mockResolvedValue(okRead());
    const out = await run();
    expect(out.reason).toBe("PERIOD_TOO_BIG");
    expect(out.status).toBe("ACTIVE");
  });

  it.each(["NO_ACCESS", "NOT_FOUND", "BILLING_DISABLED", "SA_AUTH", "INVALID_QUERY"] as const)(
    "ends in ERROR with %s and waits for a new verification",
    async (code) => {
      readBqPeriod.mockRejectedValue(new BigQueryError(code));
      const out = await run();
      expect(out).toEqual({ imported: 0, status: "ERROR", reason: code });
      expect(finalData()).toMatchObject({ status: "ERROR", lastError: code, nextRunAt: null });
    },
  );

  it("backs off on RATE_LIMIT: failures + 1 and a growing delay capped at 6 hours", async () => {
    readBqPeriod.mockRejectedValue(new BigQueryError("RATE_LIMIT"));
    const first = await run();
    expect(first).toEqual({ imported: 0, status: "ACTIVE", reason: "RATE_LIMIT" });
    expect(finalData()).toMatchObject({ consecutiveFailures: 1, lastError: "RATE_LIMIT" });
    expect(finalData().nextRunAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));

    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ consecutiveFailures: 2 }));
    await run();
    expect(finalData().nextRunAt).toEqual(new Date(NOW.getTime() + 120 * 60_000));

    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ consecutiveFailures: 9 }));
    await run();
    expect(finalData().nextRunAt).toEqual(new Date(NOW.getTime() + 6 * 3_600_000));
  });

  it.each(["TIMEOUT", "UNAVAILABLE", "UNKNOWN"] as const)("backs off on %s", async (code) => {
    readBqPeriod.mockRejectedValue(new BigQueryError(code));
    const out = await run();
    expect(out.status).toBe("ACTIVE");
    expect(finalData()).toMatchObject({ consecutiveFailures: 1, lastError: code });
  });

  it("treats a failing write as a transient failure and still releases the link lease", async () => {
    writePeriod.mockRejectedValue(new Error("db down"));
    const out = await run();
    expect(out).toEqual({ imported: 0, status: "ACTIVE", reason: "UNKNOWN" });
    expect(prisma.gscSiteLink.updateMany.mock.calls.at(-1)![0].data.syncLeaseOwner).toBeNull();
    // Para harcandı: sayaç yine de artmıştır.
    expect(addBqUsage).toHaveBeenCalledTimes(1);
  });

  it("flags a stale export without changing the status", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(
      sourceRow({ exportStart: "2026-06-01", exportedThrough: "2026-09-14" }),
    );
    prisma.gscPeriodFetch.findMany.mockResolvedValue([]);
    const out = await run();
    expect(out.status).toBe("ACTIVE");
    expect(finalData().lastError).toBe("EXPORT_LATE");
  });
});

describe("leases and time", () => {
  it("stops for this tick when the link sync lease is busy", async () => {
    prisma.gscSiteLink.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await run();
    expect(out.imported).toBe(0);
    expect(readBqPeriod).not.toHaveBeenCalled();
    expect(finalData().nextRunAt).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it("claims the link lease with a CAS on a free or expired lease", async () => {
    await run();
    const claim = prisma.gscSiteLink.updateMany.mock.calls[0]![0];
    expect(claim.where.id).toBe("link-1");
    expect(claim.where.OR).toEqual([
      { syncLeaseUntil: null },
      { syncLeaseUntil: { lt: expect.any(Date) } },
    ]);
    expect(claim.data.syncLeaseOwner).toMatch(/^gsc-bq:/);
  });

  it("claims the source lease with a CAS and does nothing when it is held", async () => {
    prisma.gscBqSource.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await run();
    expect(out).toMatchObject({ imported: 0, reason: "BUSY" });
    const claim = prisma.gscBqSource.updateMany.mock.calls[0]![0];
    expect(claim.where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: NOW } }]);
    expect(claim.data.leaseUntil).toEqual(new Date(NOW.getTime() + 10 * 60_000));
    expect(prisma.gscSiteLink.findUnique).not.toHaveBeenCalled();
  });

  it("does not start a period with less than 20 s left", async () => {
    const out = await run({ deadlineAt: Date.now() + 10_000 });
    expect(out.imported).toBe(0);
    expect(readBqPeriod).not.toHaveBeenCalled();
    expect(writePeriod).not.toHaveBeenCalled();
  });

  it("re-checks the deadline between periods", async () => {
    let calls = 0;
    readBqPeriod.mockImplementation(async () => {
      calls += 1;
      return okRead();
    });
    writePeriod.mockImplementation(async () => {
      // İlk dönemden sonra süre bitti.
      if (calls === 1) vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    });
    const out = await run({ deadlineAt: Date.now() + 60_000 });
    vi.restoreAllMocks();
    expect(out.imported).toBe(1);
  });

  it("only runs ACTIVE sources", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ status: "PAUSED" }));
    expect(await run()).toMatchObject({ imported: 0, status: "PAUSED", reason: "NOT_ACTIVE" });
    expect(prisma.gscBqSource.updateMany).not.toHaveBeenCalled();
  });
});

describe("coverage refresh", () => {
  it("refreshes the export window at most every 6 hours", async () => {
    await run();
    expect(readBqCoverage).not.toHaveBeenCalled();

    prisma.gscBqSource.findUnique.mockResolvedValue(
      sourceRow({ coverageCheckedAt: new Date("2026-10-07T12:00:00Z") }),
    );
    readBqCoverage.mockResolvedValue({ exportStart: "2026-09-01", exportedThrough: "2026-09-21", days: 20 });
    await run();
    expect(readBqCoverage).toHaveBeenCalledTimes(1);
    expect(finalData()).toMatchObject({
      exportStart: "2026-09-01",
      exportedThrough: "2026-09-21",
      coverageCheckedAt: NOW,
    });
  });

  it("ends in ERROR NO_EXPORT_DATA when the refreshed coverage is empty", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ coverageCheckedAt: null }));
    readBqCoverage.mockResolvedValue(null);
    expect(await run()).toMatchObject({ status: "ERROR", reason: "NO_EXPORT_DATA" });
  });

  it("maps a coverage query failure to a fixed code", async () => {
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ coverageCheckedAt: null }));
    readBqCoverage.mockRejectedValue(new BigQueryError("NO_ACCESS"));
    expect(await run()).toMatchObject({ status: "ERROR", reason: "NO_ACCESS" });
    readBqCoverage.mockRejectedValue(new BigQueryError("TIMEOUT"));
    expect(await run()).toMatchObject({ status: "ACTIVE", reason: "TIMEOUT" });
  });
});

describe("flag, dev guard and runDue", () => {
  it("returns without any prisma call when the flag is off", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    expect(await GscBigQuerySync.runDue(3, NOW)).toBe(0);
    expect(await run()).toMatchObject({ imported: 0 });
    for (const group of Object.values(prisma)) {
      for (const mock of Object.values(group)) expect(mock).not.toHaveBeenCalled();
    }
  });

  it("needs GSC_AGENCY and GSC_SYNC too", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscBigQuerySync.runDue(3, NOW)).toBe(0);
    expect(prisma.gscBqSource.findMany).not.toHaveBeenCalled();
  });

  it("a dev process on a shared database touches no project outside the allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.neon.tech/app");
    expect(await GscBigQuerySync.runDue(3, NOW)).toBe(0);
    expect(prisma.gscBqSource.findMany).not.toHaveBeenCalled();
    expect(prisma.gscBqSource.updateMany).not.toHaveBeenCalled();

    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "proj-1");
    prisma.gscBqSource.findMany.mockResolvedValue([]);
    await GscBigQuerySync.runDue(3, NOW);
    const where = prisma.gscBqSource.findMany.mock.calls[0]![0].where;
    expect(where.projectId).toEqual({ in: ["proj-1"] });
    // syncSource da kendi başına reddeder
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow({ projectId: "proj-2" }));
    expect(await run()).toMatchObject({ imported: 0, reason: "NOT_ALLOWED" });
  });

  it("returns BUDGET sources to ACTIVE in a new month and runs the due ones", async () => {
    prisma.gscBqSource.findMany.mockResolvedValue([
      { id: SOURCE_ID, projectId: "proj-1" },
      { id: "src-2", projectId: "proj-2" },
      { id: "src-3", projectId: "proj-3" },
      { id: "src-4", projectId: "proj-4" },
    ]);
    const total = await GscBigQuerySync.runDue(3, NOW);
    const flip = prisma.gscBqSource.updateMany.mock.calls[0]![0];
    expect(flip.where).toMatchObject({
      status: "BUDGET",
      OR: [{ usageMonth: null }, { usageMonth: { not: "2026-10" } }],
    });
    expect(flip.data).toEqual({ status: "ACTIVE", nextRunAt: null });
    // limit 3 kaynak, kaynak başına 3 dönem
    expect(total).toBe(9);
    const where = prisma.gscBqSource.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ status: "ACTIVE", isMock: false });
  });

  it("stops starting sources when the tick deadline is near", async () => {
    prisma.gscBqSource.findMany.mockResolvedValue([{ id: SOURCE_ID, projectId: "proj-1" }]);
    expect(await GscBigQuerySync.runDue(3, NOW, Date.now() + 5_000)).toBe(0);
    expect(prisma.gscBqSource.findUnique).not.toHaveBeenCalled();
  });
});

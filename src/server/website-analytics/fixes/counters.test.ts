import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_FIXES kapalıyken sayaçlar sorgusuz null döner;
// açıkken yalnız sayılar gelir (30 günlük durum dağılımı, son 200 başarısız
// satırın hata kodu dökümü, düzenleme izinli bağ sayısı, izleyici istatistiği,
// açık Agentelse-dışı uyarılar) ve hiçbir olay adı ya da mülk bilgisi yok.

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  watchAggregate: vi.fn(),
  watchCount: vi.fn(),
  alertCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaConfigChange: {
      groupBy: mocks.groupBy,
      count: mocks.count,
      findMany: mocks.findMany,
    },
    $queryRaw: mocks.queryRaw,
    gaChangeWatch: {
      aggregate: mocks.watchAggregate,
      count: mocks.watchCount,
    },
    adsAlert: { count: mocks.alertCount },
  },
}));

const { loadGaFixCounters } = await import("./counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "false");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.groupBy.mockResolvedValue([
    { status: "VERIFIED", _count: { _all: 4 } },
    { status: "FAILED", _count: { _all: 2 } },
    { status: "PROPOSED", _count: { _all: 1 } },
    { status: "REJECTED", _count: { _all: 1 } },
    { status: "UNDONE", _count: { _all: 1 } },
    { status: "EXPIRED", _count: { _all: 3 } },
  ]);
  mocks.count.mockResolvedValue(2);
  mocks.findMany.mockResolvedValue([
    { error: { code: "readback_mismatch", message: "x" } },
    { error: { code: "readback_mismatch" } },
    { error: { code: "no_property_access" } },
    { error: null },
    { error: { code: "a".repeat(80) } },
  ]);
  mocks.queryRaw.mockResolvedValue([{ n: 3 }]);
  mocks.watchAggregate.mockResolvedValue({
    _count: { _all: 5 },
    _max: { lastRunAt: new Date("2026-10-07T10:30:00.000Z") },
  });
  mocks.watchCount.mockResolvedValue(1);
  mocks.alertCount.mockResolvedValue(2);
});

describe("loadGaFixCounters", () => {
  it("returns null without any query when GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "false");
    expect(await loadGaFixCounters(NOW)).toBeNull();
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("returns null when GA_SYNC is off", async () => {
    vi.stubEnv("GA_SYNC", "false");
    expect(await loadGaFixCounters(NOW)).toBeNull();
  });

  it("returns counts only", async () => {
    expect(await loadGaFixCounters(NOW)).toEqual({
      linksWithEditAccess: 3,
      pendingApprovals: 2,
      last30d: {
        proposed: 12,
        verified: 4,
        failed: 2,
        undone: 1,
        rejected: 1,
        expired: 3,
      },
      failedByCode: { readback_mismatch: 2, no_property_access: 1, unknown: 2 },
      watch: { links: 5, lastRunMinutesAgo: 90, errors: 1 },
      outsideAlertsOpen: 2,
      alphaEnabled: false,
    });
  });

  it("windows the status counts to 30 days and samples the last 200 failures", async () => {
    await loadGaFixCounters(NOW);
    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { createdAt: { gte: new Date("2026-09-07T12:00:00.000Z") } },
      _count: { _all: true },
    });
    const sample = mocks.findMany.mock.calls[0]?.[0] as {
      where: unknown;
      take: number;
      select: unknown;
    };
    expect(sample.where).toEqual({ status: "FAILED" });
    expect(sample.take).toBe(200);
    expect(sample.select).toEqual({ error: true });
  });

  it("counts open outside-change alerts of the two watch kinds only", async () => {
    await loadGaFixCounters(NOW);
    expect(mocks.alertCount).toHaveBeenCalledWith({
      where: {
        source: "GA4",
        kind: {
          in: ["GA_CHG_KEY_EVENT_REMOVED", "GA_CHG_RETENTION_SHORTENED"],
        },
        status: { in: ["OPEN", "ACKED"] },
      },
    });
  });

  it("reports no last run before the watch ever ran, and the alpha switch", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "true");
    mocks.watchAggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { lastRunAt: null },
    });
    mocks.queryRaw.mockResolvedValue([]);
    const counters = await loadGaFixCounters(NOW);
    expect(counters?.watch).toEqual({
      links: 0,
      lastRunMinutesAgo: null,
      errors: 1,
    });
    expect(counters?.linksWithEditAccess).toBe(0);
    expect(counters?.alphaEnabled).toBe(true);
  });
});

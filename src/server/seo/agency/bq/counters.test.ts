import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: sayaçlar bayrak kapalıyken veritabanına gitmez,
// duruma göre sayar, son 7 günün BQ dönemlerini ve bu ayın faturalanan
// baytlarını verir (BigInt sayıya çevrilir, JSON'a güvenle girer).

const prisma = vi.hoisted(() => ({
  gscBqSource: { groupBy: vi.fn(), aggregate: vi.fn() },
  gscPeriodFetch: { count: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma }));

const { loadBqCounters } = await import("./counters");

const NOW = new Date("2026-10-07T12:00:00Z");

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  for (const group of Object.values(prisma)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
});

describe("loadBqCounters", () => {
  it("returns null without any query when the flag is off", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    expect(await loadBqCounters(NOW)).toBeNull();
    expect(prisma.gscBqSource.groupBy).not.toHaveBeenCalled();
    expect(prisma.gscPeriodFetch.count).not.toHaveBeenCalled();
  });

  it("counts sources by status, recent BQ periods and this month's billed bytes", async () => {
    prisma.gscBqSource.groupBy.mockResolvedValue([
      { status: "ACTIVE", _count: { _all: 4 } },
      { status: "ERROR", _count: { _all: 1 } },
      { status: "BUDGET", _count: { _all: 2 } },
      { status: "PAUSED", _count: { _all: 3 } },
      { status: "DRAFT", _count: { _all: 5 } },
    ]);
    prisma.gscPeriodFetch.count.mockResolvedValue(37);
    prisma.gscBqSource.aggregate.mockResolvedValue({
      _sum: { bytesBilledMonth: BigInt(123_456_789_012) },
    });
    const counters = await loadBqCounters(NOW);
    expect(counters).toEqual({
      sources: 15,
      active: 4,
      error: 1,
      budget: 2,
      paused: 3,
      periodsImported7d: 37,
      bytesBilledThisMonth: 123_456_789_012,
    });
    expect(() => JSON.stringify(counters)).not.toThrow();
    const where = prisma.gscPeriodFetch.count.mock.calls[0]![0].where;
    expect(where.source).toBe("BQ");
    expect(where.fetchedAt.gte).toEqual(new Date("2026-09-30T12:00:00Z"));
    expect(prisma.gscBqSource.aggregate.mock.calls[0]![0].where.usageMonth).toBe("2026-10");
  });

  it("handles an empty table", async () => {
    prisma.gscBqSource.groupBy.mockResolvedValue([]);
    prisma.gscPeriodFetch.count.mockResolvedValue(0);
    prisma.gscBqSource.aggregate.mockResolvedValue({ _sum: { bytesBilledMonth: null } });
    expect(await loadBqCounters(NOW)).toEqual({
      sources: 0,
      active: 0,
      error: 0,
      budget: 0,
      paused: 0,
      periodsImported7d: 0,
      bytesBilledThisMonth: 0,
    });
  });
});

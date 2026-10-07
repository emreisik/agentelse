import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agencyOn: vi.fn(() => true),
  riscOn: vi.fn(() => false),
  keyRing: vi.fn(() => false),
  gscOn: vi.fn(() => false),
  shareOn: vi.fn(() => true),
  shareCounters: vi.fn(),
  keyStatus: vi.fn(),
  linkCount: vi.fn(),
  linkGroupBy: vi.fn(),
  bqGroupBy: vi.fn(),
  bqAggregate: vi.fn(),
  funnelCount: vi.fn(),
  riscCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaPropertyLink: { count: mocks.linkCount, groupBy: mocks.linkGroupBy },
    gaBigQuerySource: { groupBy: mocks.bqGroupBy, aggregate: mocks.bqAggregate },
    gaFunnel: { count: mocks.funnelCount },
    googleRiscEvent: { count: mocks.riscCount },
  },
}));
vi.mock("@/lib/website-analytics/agency/flags", () => ({
  gaAgencyEnabled: mocks.agencyOn,
  googleRiscEnabled: mocks.riscOn,
}));
vi.mock("@/server/integrations/google/secret", () => ({
  googleKeyRingConfigured: mocks.keyRing,
}));
vi.mock("@/server/integrations/google/key-rotation", () => ({
  GoogleKeyRotation: { status: mocks.keyStatus },
}));
vi.mock("@/lib/seo/agency/flags", () => ({ gscAgencyOn: mocks.gscOn }));
vi.mock("@/lib/report-share/flags", () => ({ reportShareOn: mocks.shareOn }));
vi.mock("@/server/report-share/counters", () => ({
  loadShareCounters: mocks.shareCounters,
}));

import { loadGaAgencyCounters } from "./counters";

// Bu dosyanın kanıtladığı (GA-F8, /health): her şey kapalıyken sorgu yok;
// açıkken yalnız sayılar; ekstra mülk kovaları; paylaşım sayaçları yalnız
// Search agency kapalıyken ve hatada null.

const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agencyOn.mockReturnValue(true);
  mocks.riscOn.mockReturnValue(false);
  mocks.keyRing.mockReturnValue(false);
  mocks.gscOn.mockReturnValue(false);
  mocks.shareOn.mockReturnValue(true);
  mocks.shareCounters.mockResolvedValue({
    active: 3,
    created7d: 2,
    viewed7d: 9,
    brandedWorkspaces: 1,
  });
  mocks.keyStatus.mockResolvedValue(null);
  mocks.linkCount.mockResolvedValue(0);
  mocks.linkGroupBy.mockResolvedValue([]);
  mocks.bqGroupBy.mockResolvedValue([]);
  mocks.bqAggregate.mockResolvedValue({ _sum: { usageBytes: null } });
  mocks.funnelCount.mockResolvedValue(0);
  mocks.riscCount.mockResolvedValue(0);
});

function numbers(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  return Object.values(value).flatMap(numbers);
}

describe("loadGaAgencyCounters", () => {
  it("is null without any query when everything is off", async () => {
    mocks.agencyOn.mockReturnValue(false);
    expect(await loadGaAgencyCounters(NOW)).toBeNull();
    expect(mocks.linkCount).not.toHaveBeenCalled();
    expect(mocks.riscCount).not.toHaveBeenCalled();
  });

  it("answers when only RISC or only the key ring is on", async () => {
    mocks.agencyOn.mockReturnValue(false);
    mocks.riscOn.mockReturnValue(true);
    expect(await loadGaAgencyCounters(NOW)).not.toBeNull();
    mocks.riscOn.mockReturnValue(false);
    mocks.keyRing.mockReturnValue(true);
    expect(await loadGaAgencyCounters(NOW)).not.toBeNull();
  });

  it("returns counts only", async () => {
    mocks.linkCount.mockResolvedValue(5);
    mocks.linkGroupBy.mockResolvedValue([{ workspaceId: "w1" }, { workspaceId: "w2" }]);
    mocks.bqGroupBy.mockResolvedValue([
      { status: "OK", _count: { _all: 2 } },
      { status: "ERROR", _count: { _all: 1 } },
    ]);
    mocks.bqAggregate.mockResolvedValue({ _sum: { usageBytes: BigInt(123456789) } });
    mocks.funnelCount.mockResolvedValue(4);
    mocks.riscCount.mockResolvedValue(6);
    mocks.keyStatus.mockResolvedValue({
      currentKeyId: "k2",
      legacyRows: 1,
      currentRows: 2,
      otherRows: 0,
      totalRows: 3,
    });
    const counters = await loadGaAgencyCounters(NOW);
    expect(counters).toMatchObject({
      links: { main: 5, extra: 5, workspacesWithExtras: 2, extraHealthNotOk: 5, extraStale72h: 5 },
      bigQuery: { pending: 0, ok: 2, error: 1, bytesThisMonth: 123456789 },
      funnels: { defined: 4, ran24h: 4, failed: 4 },
      risc: { received24h: 6, applied24h: 6, received30d: 6, recheck30d: 6, pending: 6 },
    });
    // Anahtar kimliği dışında hiçbir metin alanı yok (Google verisi sızmaz).
    const leaves = numbers({ ...counters, keys: null, shares: null });
    expect(leaves.every((leaf) => typeof leaf === "number" || leaf === null)).toBe(true);
  });

  it("buckets extra properties with the right filters", async () => {
    await loadGaAgencyCounters(NOW);
    const wheres = mocks.linkCount.mock.calls.map((call) => call[0].where);
    expect(wheres).toContainEqual({ isPrimary: true });
    expect(wheres).toContainEqual({ isSecondary: true });
    expect(wheres).toContainEqual({ isSecondary: true, health: { not: "OK" } });
    const stale = wheres.find((where) => where.OR);
    expect(stale.isSecondary).toBe(true);
    // 72 saat = bugünden 3 gün önce.
    expect(stale.OR[0]).toEqual({ lastDailyDate: { lt: "2026-10-04" } });
    expect(stale.OR[1].lastDailyDate).toBeNull();
  });

  it("uses this month's budget counters only", async () => {
    await loadGaAgencyCounters(NOW);
    expect(mocks.bqAggregate.mock.calls[0]?.[0].where).toEqual({ usageMonth: "2026-10" });
  });

  it("includes SC-F9's share counters only when Search agency is off", async () => {
    const off = await loadGaAgencyCounters(NOW);
    expect(off?.shares).toEqual({ active: 3, created7d: 2, viewed7d: 9, brandedWorkspaces: 1 });

    mocks.gscOn.mockReturnValue(true);
    mocks.shareCounters.mockClear();
    const on = await loadGaAgencyCounters(NOW);
    expect(on?.shares).toBeNull();
    expect(mocks.shareCounters).not.toHaveBeenCalled();
  });

  it("has no share counters when sharing is off or the read fails", async () => {
    mocks.shareOn.mockReturnValue(false);
    expect((await loadGaAgencyCounters(NOW))?.shares).toBeNull();
    expect(mocks.shareCounters).not.toHaveBeenCalled();

    mocks.shareOn.mockReturnValue(true);
    mocks.shareCounters.mockRejectedValue(new Error("db"));
    expect((await loadGaAgencyCounters(NOW))?.shares).toBeNull();
  });

  it("degrades a failing counter to zero instead of failing everything", async () => {
    mocks.funnelCount.mockRejectedValue(new Error("db"));
    mocks.keyStatus.mockRejectedValue(new Error("db"));
    const counters = await loadGaAgencyCounters(NOW);
    expect(counters?.funnels).toEqual({ defined: 0, ran24h: 0, failed: 0 });
    expect(counters?.keys).toBeNull();
  });
});

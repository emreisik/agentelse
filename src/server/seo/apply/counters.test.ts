import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SEO_APPLY kapalıyken sayaçlar DB okumadan null
// döner; açıkken yalnız sayılar gelir (30 günlük durum ve tür dağılımı, son
// başarısız satırların hata kodu dökümü, IndexNow ve SC-F6 bağ sayıları) ve
// hiçbir sayfa adresi, başlık ya da kimlik yok.

const mocks = vi.hoisted(() => ({
  siteCount: vi.fn(),
  changeCount: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
  settingCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cmsSite: { count: mocks.siteCount },
    seoChange: {
      count: mocks.changeCount,
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
    seoApplySetting: { count: mocks.settingCount },
  },
}));

const { loadSeoApplyCounters } = await import("./counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_APPLY", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.siteCount.mockImplementation(
    async (args?: unknown) => (args ? 2 : 3),
  );
  mocks.changeCount.mockImplementation(
    async (args: { where: Record<string, unknown> }) => {
      if (args.where.status === "PROPOSED") return 4;
      if (args.where.seoActionId) return 6;
      const state = (args.where.indexNow as { equals?: string } | undefined)
        ?.equals;
      if (state === "SENT") return 9;
      if (state === "FAILED") return 1;
      return 0;
    },
  );
  mocks.groupBy.mockImplementation(async (args: { by: string[] }) =>
    args.by[0] === "status"
      ? [
          { status: "VERIFIED", _count: { _all: 5 } },
          { status: "FAILED", _count: { _all: 2 } },
          { status: "PROPOSED", _count: { _all: 1 } },
          { status: "REJECTED", _count: { _all: 1 } },
          { status: "UNDONE", _count: { _all: 1 } },
          { status: "EXPIRED", _count: { _all: 3 } },
        ]
      : [
          { kind: "TITLE_META", _count: { _all: 8 } },
          { kind: "PUBLISH_ARTICLE", _count: { _all: 5 } },
        ],
  );
  mocks.findMany.mockResolvedValue([
    { error: { code: "readback_mismatch", message: "x" } },
    { error: { code: "readback_mismatch" } },
    { error: { code: "page_changed" } },
    { error: null },
    { error: { code: "a".repeat(80) } },
  ]);
  mocks.settingCount.mockResolvedValue(2);
});

describe("loadSeoApplyCounters", () => {
  it("returns null without any DB read while SEO_APPLY is off", async () => {
    vi.unstubAllEnvs();
    expect(await loadSeoApplyCounters(NOW)).toBeNull();
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("returns counts only", async () => {
    const counters = await loadSeoApplyCounters(NOW);
    expect(counters).toEqual({
      sites: 3,
      healthy: 2,
      pendingApprovals: 4,
      last30d: {
        proposed: 13,
        verified: 5,
        failed: 2,
        undone: 1,
        rejected: 1,
        expired: 3,
      },
      byKind30d: { TITLE_META: 8, PUBLISH_ARTICLE: 5 },
      failedByCode: { readback_mismatch: 2, page_changed: 1, unknown: 2 },
      indexNow: { projects: 2, sent30d: 9, failed30d: 1 },
      linkedActions: 6,
    });
  });

  it("only reads the 30 day window and only the error column of failed rows", async () => {
    await loadSeoApplyCounters(NOW);
    const since = new Date(NOW.getTime() - 30 * 24 * 3_600_000);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "FAILED", createdAt: { gte: since } },
        select: { error: true },
      }),
    );
  });
});

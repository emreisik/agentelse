import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SEO_REPORTS kapalıyken sorgu yapılmadan null;
// açıkken yalnız sayılar döner (sayaç adları ve penceler: haftalık 7 gün,
// aylık ve yol haritası 35 gün, nabız 7 gün, anlatısız 30 gün).

const mocks = vi.hoisted(() => ({
  reportCount: vi.fn(),
  stateCount: vi.fn(),
  progressCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoReport: { count: mocks.reportCount },
    seoReportState: { count: mocks.stateCount },
    seoGoalProgress: { count: mocks.progressCount },
  },
}));

const { loadSeoReportCounters } = await import("./counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSeoReportCounters", () => {
  it("returns null without any database read when off", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    expect(await loadSeoReportCounters(NOW)).toBeNull();
    vi.stubEnv("SEO_REPORTS", "true");
    vi.stubEnv("GSC_SYNC", "false");
    expect(await loadSeoReportCounters(NOW)).toBeNull();
    expect(mocks.reportCount).not.toHaveBeenCalled();
    expect(mocks.stateCount).not.toHaveBeenCalled();
    expect(mocks.progressCount).not.toHaveBeenCalled();
  });

  it("returns numbers only, with the documented windows", async () => {
    mocks.reportCount
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    mocks.stateCount.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
    mocks.progressCount.mockResolvedValue(5);

    const counters = await loadSeoReportCounters(NOW);
    expect(counters).toEqual({
      linksTracked: 7,
      weekly7d: 4,
      monthly35d: 1,
      pulses7d: 9,
      roadmaps35d: 1,
      narrativeSkipped30d: 3,
      failingLinks: 2,
      goalsTracked: 5,
    });
    for (const value of Object.values(counters ?? {})) {
      expect(typeof value).toBe("number");
    }

    const wheres = mocks.reportCount.mock.calls.map((call) => call[0].where);
    expect(wheres[0]).toMatchObject({ kind: "WEEKLY", isMock: false });
    expect(wheres[0].createdAt.gte).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(wheres[1].createdAt.gte).toEqual(new Date(NOW.getTime() - 35 * DAY));
    expect(wheres[2]).toMatchObject({ kind: "PULSE" });
    expect(wheres[3]).toMatchObject({ kind: "ROADMAP" });
    expect(wheres[4].kind).toEqual({ in: ["WEEKLY", "MONTHLY"] });
    expect(wheres[4].createdAt.gte).toEqual(new Date(NOW.getTime() - 30 * DAY));
    expect(mocks.stateCount.mock.calls[1]?.[0].where).toMatchObject({
      consecutiveFailures: { gt: 0 },
    });
  });

  it("counts sample-data rows in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    mocks.reportCount.mockResolvedValue(0);
    mocks.stateCount.mockResolvedValue(0);
    mocks.progressCount.mockResolvedValue(0);
    await loadSeoReportCounters(NOW);
    expect(mocks.progressCount.mock.calls[0]?.[0]).toEqual({
      where: { isMock: true },
    });
  });
});

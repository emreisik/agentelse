import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F4 operatör sayaçları): SEO_INSIGHTS=off iken
// sorgu yok; kesinlik = useful / (useful + notUseful); sorgular yalnız sayı
// ve kural anahtarı seçer (başlık, özet, kanıt, anahtar kelime asla).

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  mock: vi.fn(),
  stateCount: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock("@/lib/seo/insight-flags", () => ({
  SeoInsightFlags: { mode: mocks.mode },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mock,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoEngineState: { count: mocks.stateCount },
    seoFinding: { groupBy: mocks.groupBy },
  },
}));

const { loadSeoOpportunityCounters } = await import("./operator-counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const FORBIDDEN = ["title", "summary", "evidence", "keyword", "explanation"];

type GroupArgs = { by: string[]; where: Record<string, unknown> };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.mode.mockReturnValue("shadow");
  mocks.mock.mockReturnValue(false);
  mocks.stateCount.mockResolvedValue(0);
  mocks.groupBy.mockImplementation(async (args: GroupArgs) =>
    args.by.includes("review")
      ? [
          {
            ruleKey: "SO1_STRIKING_DISTANCE",
            review: "USEFUL",
            _count: { _all: 7 },
          },
          {
            ruleKey: "SO1_STRIKING_DISTANCE",
            review: "NOT_USEFUL",
            _count: { _all: 1 },
          },
          {
            ruleKey: "SO3_CONTENT_DECAY",
            review: "NOT_USEFUL",
            _count: { _all: 2 },
          },
        ]
      : [
          { ruleKey: "SO1_STRIKING_DISTANCE", _count: { _all: 12 } },
          { ruleKey: "SO3_CONTENT_DECAY", _count: { _all: 4 } },
        ],
  );
});

describe("loadSeoOpportunityCounters", () => {
  it("returns null without a query when SEO_INSIGHTS is off", async () => {
    mocks.mode.mockReturnValue("off");
    await expect(loadSeoOpportunityCounters(NOW)).resolves.toBeNull();
    expect(mocks.stateCount).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("counts per rule and computes precision", async () => {
    mocks.stateCount
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const counters = await loadSeoOpportunityCounters(NOW);
    expect(counters).toMatchObject({
      mode: "shadow",
      linksTracked: 5,
      ran24h: 4,
      failing: 1,
      llmSkippedBudget: 2,
      findings14d: 16,
      reviewed: 10,
      precision: 0.7,
    });
    expect(counters?.byRule).toHaveLength(16);
    expect(
      counters?.byRule.find((row) => row.ruleKey === "SO1_STRIKING_DISTANCE"),
    ).toEqual({
      ruleKey: "SO1_STRIKING_DISTANCE",
      created14d: 12,
      useful: 7,
      notUseful: 1,
    });
    expect(
      counters?.byRule.find((row) => row.ruleKey === "SO16_TECH_IMPACT"),
    ).toEqual({
      ruleKey: "SO16_TECH_IMPACT",
      created14d: 0,
      useful: 0,
      notUseful: 0,
    });
  });

  it("has no precision before the first review", async () => {
    mocks.groupBy.mockResolvedValue([]);
    const counters = await loadSeoOpportunityCounters(NOW);
    expect(counters?.reviewed).toBe(0);
    expect(counters?.precision).toBeNull();
  });

  it("selects only counts and the rule key, in the current mode", async () => {
    mocks.mock.mockReturnValue(true);
    await loadSeoOpportunityCounters(NOW);
    const calls = mocks.groupBy.mock.calls.map(
      ([args]) => args as GroupArgs & { _count: unknown; select?: unknown },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      by: ["ruleKey"],
      where: {
        createdAt: { gte: new Date("2026-09-23T12:00:00.000Z") },
        link: { isMock: true },
      },
      _count: { _all: true },
    });
    expect(calls[1]).toEqual({
      by: ["ruleKey", "review"],
      where: {
        reviewedAt: { gte: new Date("2026-09-07T12:00:00.000Z") },
        review: { in: ["USEFUL", "NOT_USEFUL"] },
        link: { isMock: true },
      },
      _count: { _all: true },
    });
    const serialized = JSON.stringify([
      ...mocks.groupBy.mock.calls,
      ...mocks.stateCount.mock.calls,
    ]);
    for (const field of FORBIDDEN) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    // Bütçe atlaması Json yol süzgeciyle sayılır.
    expect(mocks.stateCount).toHaveBeenCalledWith({
      where: {
        isMock: true,
        lastRunStats: { path: ["llmSkipped"], equals: "budget" },
      },
    });
  });

  it("turns a failing count into zero", async () => {
    mocks.stateCount.mockRejectedValue(new Error("db down"));
    mocks.groupBy.mockRejectedValue(new Error("db down"));
    const counters = await loadSeoOpportunityCounters(NOW);
    expect(counters).toMatchObject({
      linksTracked: 0,
      findings14d: 0,
      reviewed: 0,
      precision: null,
    });
  });
});
